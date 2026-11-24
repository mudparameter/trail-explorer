// Downloads the road data areas need, in the background, and works out what each
// area holds. Data is fetched by tile, a few tiles at a time, and saved as each
// part arrives: a big area survives a restart, and areas that overlap never wait
// for or download the same tile twice.
import type { AreaView, GroupView } from '../core/api.ts';
import type { Area, AreaGroup } from '../core/areas.ts';
import { KINDS, kindTotals, overpassQuery, parseOverpass, roadsIn, roadsInCircles, tilesFor, type Road, type RoadKind } from '../core/roads.ts';
import type { OsmWay } from '../core/roads.ts';
import type { OsmStore } from './osm.ts';

/** Tiles per download. Small enough that a busy server still answers. */
const PART = 16;
/** Downloads at once. Public Overpass servers allow about two per computer. */
const AT_ONCE = 2;

interface Cached {
  sig: string;
  roads: Road[];
  version: number;
}

export class Areas {
  private store: OsmStore;
  private fetch: (query: string) => Promise<unknown>;
  private changed: () => void;
  private areas: Area[] = [];
  private groups: AreaGroup[] = [];
  /** Tiles each area touches, by area signature. */
  private tiles = new Map<string, number[]>();
  /** Tiles being downloaded now. */
  private claimed = new Set<number>();
  private failed = new Map<string, string>();
  private roads = new Map<string, Cached>();
  private running = 0;
  private version = 0;
  private stopped = false;

  constructor(store: OsmStore, fetch: (query: string) => Promise<unknown>, changed: () => void) {
    this.store = store;
    this.fetch = fetch;
    this.changed = changed;
  }

  private sig = (a: Area) => `${a.center[0]},${a.center[1]},${a.radius}`;
  private tilesOf(a: Area): number[] {
    const s = this.sig(a);
    let t = this.tiles.get(s);
    if (!t) this.tiles.set(s, (t = tilesFor(a.center, a.radius)));
    return t;
  }
  private missing = (a: Area) => this.tilesOf(a).filter((k) => !this.store.has(k));

  private members = (g: string) => this.areas.filter((a) => a.group === g);
  /** A joined group's circles, which change its roads when they change. */
  private groupSig = (g: string) => this.members(g).map(this.sig).join(';');

  /** The areas and groups from the config. Starts downloading anything they need. */
  set(areas: Area[], groups: AreaGroup[] = []) {
    this.areas = areas;
    this.groups = groups;
    const sigs = new Set(areas.map(this.sig));
    for (const s of this.tiles.keys()) if (!sigs.has(s)) this.tiles.delete(s);
    for (const [id, c] of this.roads) {
      const a = areas.find((x) => x.id === id);
      const g = groups.find((x) => x.id === id && x.joined);
      if (!(a && this.sig(a) === c.sig) && !(g && this.groupSig(g.id) === c.sig)) this.roads.delete(id);
    }
    for (const id of this.failed.keys()) if (!areas.some((a) => a.id === id)) this.failed.delete(id);
    this.pump();
    this.changed();
  }

  /** Tries an area again, or every area in a group. */
  retry(id: string) {
    this.failed.delete(id);
    for (const a of this.members(id)) this.failed.delete(a.id);
    this.pump();
    this.changed();
  }

  stop() {
    this.stopped = true;
  }

  /** Drops downloaded data no area uses any more. */
  prune() {
    const keep = new Set(this.areas.flatMap((a) => this.tilesOf(a)));
    for (const k of this.claimed) keep.add(k);
    return this.store.prune(keep);
  }

  /** The roads in an area or a joined group, once all its data is here. */
  roadsOf(id: string): Cached | null {
    const g = this.groups.find((x) => x.id === id && x.joined);
    if (g) {
      const ms = this.members(g.id);
      if (!ms.length || ms.some((m) => this.missing(m).length)) return null;
      const sig = this.groupSig(g.id);
      const c = this.roads.get(id);
      if (c && c.sig === sig) return c;
      const ways = new Map<number, OsmWay>();
      for (const m of ms) for (const w of this.store.waysIn(m.center, m.radius)) ways.set(w.id, w);
      const fresh = { sig, roads: roadsInCircles([...ways.values()], ms.map((m) => ({ center: m.center, radius: m.radius }))), version: ++this.version };
      this.roads.set(id, fresh);
      return fresh;
    }
    const a = this.areas.find((x) => x.id === id);
    if (!a || this.missing(a).length) return null;
    const c = this.roads.get(id);
    if (c && c.sig === this.sig(a)) return c;
    const fresh = { sig: this.sig(a), roads: roadsIn(this.store.waysIn(a.center, a.radius), a.center, a.radius), version: ++this.version };
    this.roads.set(id, fresh);
    return fresh;
  }

  view(): AreaView[] {
    return this.areas.map((a) => {
      const all = this.tilesOf(a);
      const missing = this.missing(a);
      const base = { ...a, total: all.length, done: all.length - missing.length, error: null as string | null, version: 0, totals: {} };
      if (!missing.length) {
        const c = this.roadsOf(a.id)!;
        return { ...base, state: 'ready', version: c.version, totals: kindTotals(c.roads) };
      }
      const err = this.failed.get(a.id);
      if (err) return { ...base, state: 'error', error: err };
      return { ...base, state: missing.some((k) => this.claimed.has(k)) ? 'downloading' : 'queued' };
    });
  }

  groupView(views = this.view()): GroupView[] {
    return this.groups.flatMap((g): GroupView[] => {
      const ms = views.filter((a) => a.group === g.id);
      if (!ms.length) return [];
      const tiles = new Set(ms.flatMap((m) => this.tilesOf(m)));
      const done = [...tiles].filter((k) => this.store.has(k)).length;
      const hide = KINDS.map((k) => k.kind).filter((k: RoadKind) => ms.every((m) => m.hide.includes(k)));
      const err = ms.find((m) => m.state === 'error');
      const state: GroupView['state'] = err ? 'error' : ms.every((m) => m.state === 'ready') ? 'ready' : ms.some((m) => m.state === 'downloading') ? 'downloading' : 'queued';
      const base = { ...g, members: ms.map((m) => m.id), on: ms.every((m) => m.on), hide, state, error: err?.error ?? null, done, total: tiles.size, version: 0, totals: {} };
      if (!g.joined || state !== 'ready') return [base];
      const c = this.roadsOf(g.id)!;
      return [{ ...base, version: c.version, totals: kindTotals(c.roads) }];
    });
  }

  /** Starts downloads until AT_ONCE are running. Areas are served in list order. */
  private pump() {
    while (!this.stopped && this.running < AT_ONCE) {
      let job: { id: string; tiles: number[] } | null = null;
      for (const a of this.areas) {
        if (this.failed.has(a.id)) continue;
        const free = this.missing(a).filter((k) => !this.claimed.has(k));
        if (free.length) {
          job = { id: a.id, tiles: free.slice(0, PART) };
          break;
        }
      }
      if (!job) return;
      for (const k of job.tiles) this.claimed.add(k);
      this.running++;
      void this.run(job);
    }
  }

  private async run({ id, tiles }: { id: string; tiles: number[] }) {
    try {
      const reply = await this.fetch(overpassQuery(tiles));
      if (this.stopped) return;
      this.store.save(parseOverpass(reply), tiles);
    } catch (e) {
      if (this.stopped) return;
      this.failed.set(id, e instanceof Error ? e.message : 'The download failed.');
      console.error('Road data download failed:', e);
    } finally {
      for (const k of tiles) this.claimed.delete(k);
      this.running--;
    }
    this.pump();
    this.changed();
  }
}
