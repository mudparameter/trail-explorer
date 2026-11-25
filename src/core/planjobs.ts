// Route planning jobs, run in a worker: a Node process on the desktop, a Web
// Worker in a browser. The network for the chosen areas is built once and kept
// here, so trying different requests is quick. No Node, Electron or DOM here.
import type { FeatureCollection } from 'geojson';
import { buildNetwork, coverage, networkGeoJson, RideIndex, type Network } from './network.ts';
import type { Shape } from './shapes.ts';
import { favoriteEdges, MAGIC, overlap, Planner, type MagicRequest, type Planned, type PlanRequest } from './planner.ts';
import { describe, elevated, statsOfLine, steepestDescents, type Difficulty, type PlannedRoute } from './route.ts';
import type { OsmWay } from './roads.ts';
import { addHeights, DESCENT_DEFAULTS, type DescentWish } from './descent.ts';
import { KINDS } from './roads.ts';
import { decodeTerrarium, Elevation, TERRAIN_ZOOM } from './terrain.ts';
import { unpackTrack } from './track.ts';

export interface NetworkJob {
  key: string;
  ways: OsmWay[];
  shapes: Shape[];
  /** Packed tracks of the rides that count as ridden. */
  tracks: Float64Array[];
  bounds: [number, number, number, number];
  /** Where the host keeps elevation tiles, passed back to its tile reader. */
  terrain: string;
}
export interface NetworkResult {
  geojson: FeatureCollection;
  total: number;
  ridden: number;
}

let current: { key: string; net: Network; terrain: string } | null = null;

/**
 * How the host reads an elevation tile's PNG, from wherever it keeps them: a
 * folder on the desktop, IndexedDB in a browser (loaded before the job runs, as
 * this must answer at once). Null when it has none: there is no elevation there.
 */
let readTile: (terrain: string, x: number, y: number) => Uint8Array | null = () => null;
export function setTileReader(fn: typeof readTile) {
  readTile = fn;
  tiles.clear();
}

/** Decoded elevation tiles, most recent last. About 260 kB each. */
const tiles = new Map<string, Float32Array | null>();
const MAX_TILES = 300;
function elevation(terrain: string) {
  return new Elevation((x, y) => {
    const key = `${terrain}/${TERRAIN_ZOOM}/${x}/${y}`;
    let t = tiles.get(key);
    if (t === undefined) {
      try {
        const png = readTile(terrain, x, y);
        t = png ? decodeTerrarium(png) : null;
      } catch {
        t = null;
      }
      if (tiles.size >= MAX_TILES) tiles.delete(tiles.keys().next().value!);
    } else tiles.delete(key);
    tiles.set(key, t);
    return t;
  });
}

export function network(job: NetworkJob): NetworkResult {
  const lines = job.tracks.flatMap((t) => unpackTrack(t));
  const index = new RideIndex(lines, job.bounds);
  const net = buildNetwork(job.ways, job.shapes, index.ridden, index.passes);
  // How steep each path is going down either way, so a limit on descents can leave it out.
  const ele = elevation(job.terrain);
  const at = (lon: number, lat: number) => ele.at(lon, lat);
  for (const e of net.edges) {
    const line: [number, number][] = [];
    for (let k = 0; k < e.coords.length; k += 2) line.push([e.coords[k]!, e.coords[k + 1]!]);
    e.down = steepestDescents(line, at);
  }
  // Heights for finding long descents, when a route asks for one.
  addHeights(net, at);
  current = { key: job.key, net, terrain: job.terrain };
  return { geojson: networkGeoJson(net), ...coverage(net) };
}

/** A planned route's id, from its edges: the same route always gets the same one. */
const routeId = (p: Planned) => hash48(JSON.stringify(p.steps));
/** 12 hex digits from two 32-bit FNV-1a hashes of a string. */
function hash48(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return ((a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
}
const LEVELS: Difficulty[] = ['Easy', 'Moderate', 'Hard', 'Very hard'];

function ready(key: string) {
  if (!current || current.key !== key) throw new Error('The areas need preparing again. Go back to step 1.');
  const ele = elevation(current.terrain);
  const at = (lon: number, lat: number) => ele.at(lon, lat);
  const climbs = new WeakMap<Planned, number>();
  const climbOf = (p: Planned) => {
    let c = climbs.get(p);
    if (c === undefined) {
      climbs.set(p, (c = statsOfLine(elevated(p.line, at)).gain));
    }
    return c;
  };
  return { net: current.net, at, climbOf };
}

type Found = { p: Planned; r: PlannedRoute; s: number };

/** Up to five of the best, each different enough from the ones before. */
function pickDiverse(net: Network, ranked: Found[]): PlannedRoute[] {
  const out: Found[] = [];
  for (const limit of [0.5, 0.75, 0.9, 1.01]) {
    for (const x of ranked) {
      if (out.length >= 5) break;
      if (out.includes(x) || out.some((y) => overlap(net.edges, x.p, y.p) > limit)) continue;
      out.push(x);
    }
    if (out.length >= Math.min(3, ranked.length)) break;
  }
  return out.map((x) => x.r);
}

/**
 * Routes for a request. With a tolerance, routes are planned for the distance and
 * half the tolerance either side, and the ones within it come first, closest
 * first. `seen` are routes already shown, left out so a new set is new. With a
 * `difficulty`, routes rated that way come first.
 */
export function routes({ key, request, seen = [], difficulty = null }: { key: string; request: PlanRequest; seen?: string[]; difficulty?: Difficulty | null }): PlannedRoute[] {
  const { net, at, climbOf } = ready(key);
  const d = request.distance;
  const tol = request.tolerance ?? null;
  const dists = tol ? [d, d + tol / 2, d - tol / 2].filter((x) => x >= 500) : [d];
  const found = new Map<string, Found>();
  let problem: unknown = null;
  for (const [run, dist] of dists.entries()) {
    let list: { p: Planned; r: PlannedRoute }[];
    try {
      list = plain(net, { ...request, distance: dist }, dists.length > 1 || seen.length ? 10 : undefined, at, climbOf);
    } catch (e) {
      problem = e;
      continue;
    }
    list.forEach(({ p, r }, i) => {
      if (found.has(r.id)) return;
      // The planner's own order within a run, then runs nearer the distance first.
      let s = i * 0.05 + run * 0.01;
      if (tol !== null) {
        const off = Math.abs(r.stats.distance - d);
        s += (off <= tol ? 0 : 10 + off / Math.max(tol, 1)) + (0.3 * off) / Math.max(tol, 1);
      }
      if (difficulty) s += 3 * Math.abs(r.rating.level - (LEVELS.indexOf(difficulty) + 1));
      found.set(r.id, { p, r, s });
    });
  }
  if (!found.size) {
    if (problem) throw problem;
    return [];
  }
  const fresh = [...found.values()].filter((x) => !seen.includes(x.r.id));
  if (!fresh.length) throw new Error('No other routes from there. Try changing the ride, or another start.');
  return pickDiverse(net, fresh.sort((a, b) => a.s - b.s || (a.r.id < b.r.id ? -1 : 1)));
}

function plain(net: Network, request: PlanRequest, count: number | undefined, at: (lon: number, lat: number) => number, climbOf: (p: Planned) => number): { p: Planned; r: PlannedRoute }[] {
  const maxDown = request.maxDown ?? null, maxUp = request.maxUp ?? null;
  const limited = maxDown !== null || maxUp !== null;
  // With a limit, ask for spares: a route can still be too steep where two paths meet.
  const planned = new Planner(net, request).plan(count ?? (limited ? 8 : 5), climbOf);
  const out = planned.map((p) => ({ p, r: describe(p, at, request.finish === null, routeId(p)) }));
  if (!limited) return out;
  const ok = out.filter(({ r }) => (maxDown === null || r.stats.maxDown <= maxDown) && (maxUp === null || r.stats.maxUp <= maxUp));
  if (planned.length && !ok.length) {
    const what = [maxUp !== null && `climbs to ${maxUp}%`, maxDown !== null && `descents to ${maxDown}%`].filter(Boolean).join(' and ');
    throw new Error(`No route from there keeps ${what} or less. Try a higher limit, more kinds of path, or another start.`);
  }
  return ok;
}

/**
 * The magic planner: routes near a distance (within a tolerance) and of a
 * difficulty, with everything else chosen to suit that difficulty. It tries
 * several distances and mixes of new trail, keeps routes that are near enough,
 * and picks the ones closest to the difficulty, each different from the rest.
 */
export function magic({ key, request, seen = [] }: { key: string; request: MagicRequest; seen?: string[] }): PlannedRoute[] {
  const { net, at, climbOf } = ready(key);
  const want = LEVELS.indexOf(request.difficulty) + 1;
  const prof = MAGIC[request.difficulty];
  const { distance: d, tolerance: tol } = request;
  const found = new Map<string, { p: Planned; r: PlannedRoute }>();
  let problem: unknown = null;
  for (const dist of [d, d + tol / 2, d - tol / 2].filter((x) => x >= 500)) {
    for (const newTrail of ['some', 'lots', 'little'] as const) {
      const req: PlanRequest = {
        start: request.start, finish: request.finish, distance: dist, climb: Math.round((prof.climbPerKm * dist) / 1000), newTrail,
        kinds: ['trail', 'track', 'cycleway', 'road'], allowRestricted: false,
        maxUp: prof.maxUp, maxDown: prof.maxDown, maxLevel: prof.maxLevel, variant: request.variant ?? 0, favorites: request.favorites === true,
        descent: request.descent ?? null,
      };
      let planned: Planned[];
      try {
        planned = new Planner(net, req).plan(8, climbOf);
      } catch (e) {
        problem = e;
        continue;
      }
      for (const p of planned) {
        const id = routeId(p);
        if (!found.has(id) && !seen.includes(id)) found.set(id, { p, r: describe(p, at, request.finish === null, id) });
      }
    }
  }
  const all = [...found.values()];
  // With a long descent asked for, the planner's reason (no descent that long, say) is the one to give.
  if (!all.length && request.descent && problem) throw problem;
  if (!all.length) throw new Error(seen.length ? 'No other routes from there. Try another distance or difficulty, or another start.' : 'No routes could be made from there. Try another start, or a bigger area.');
  // Near enough in distance first; then the closest difficulty and climbing to suit it,
  // and with favourites asked for, routes with about a quarter on them (or all there are).
  const favLength = request.favorites ? [...favoriteEdges(net)].reduce((n, i) => n + net.edges[i]!.len, 0) : 0;
  const score = ({ r }: { r: PlannedRoute }) => {
    const off = Math.abs(r.stats.distance - d);
    const perKm = r.stats.gain / Math.max(1, r.stats.distance / 1000);
    const favWant = Math.min(r.stats.distance / 4, favLength);
    const fav = favLength ? 2 * Math.max(0, 1 - (r.favorite ?? 0) / Math.max(favWant, 1)) : 0;
    return (off <= tol ? 0 : 10 + off / Math.max(tol, 1)) + 3 * Math.abs(r.rating.level - want) + Math.abs(perKm - prof.climbPerKm) / prof.climbPerKm + (0.3 * off) / Math.max(tol, 1) + fav;
  };
  return pickDiverse(net, all.map((x) => ({ ...x, s: score(x) })).sort((a, b) => a.s - b.s || (a.r.id < b.r.id ? -1 : 1)));
}

// --- requests from the window --------------------------------------------------------

/** Asking again: which variant, the routes already shown, and the difficulty wished for. */
function planMore(o: unknown) {
  const x = (o ?? {}) as { variant?: unknown; seen?: unknown; difficulty?: unknown };
  const variant = Number.isInteger(x.variant) && (x.variant as number) >= 0 && (x.variant as number) < 1e6 ? (x.variant as number) : 0;
  const seen = Array.isArray(x.seen) ? x.seen.filter((s): s is string => typeof s === 'string').slice(0, 500) : [];
  const difficulty = typeof x.difficulty === 'string' && x.difficulty in MAGIC ? (x.difficulty as Difficulty) : null;
  return { variant, seen, difficulty };
}
/** A long descent asked for, checked; null when not asked for. */
function descentOf(x: any): DescentWish | null {
  if (x == null) return null;
  if (!(typeof x.length === 'number' && x.length >= 500 && x.length <= 100_000)) throw new Error('Choose a descent length from 0.5 to 100 km.');
  if (!(typeof x.maxClimb === 'number' && x.maxClimb >= 0 && x.maxClimb <= 500)) throw new Error('Choose the most the descent may climb, from 0 to 500 m.');
  if (!(typeof x.minGrade === 'number' && x.minGrade >= DESCENT_DEFAULTS.minGrade && x.minGrade <= 50)) throw new Error(`Choose the descent's average steepness, from ${DESCENT_DEFAULTS.minGrade} to 50%.`);
  return { length: x.length, maxClimb: x.maxClimb, minGrade: x.minGrade };
}
const point = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

/** A request for routes from the window, checked, as the planRoutes job takes it. Throws a message for people. */
export function planRoutesJob(key: unknown, x: unknown, o: unknown): { key: string; request: PlanRequest; seen: string[]; difficulty: Difficulty | null } {
  const r = x as any;
  if (typeof key !== 'string' || !r || !point(r.start) || (r.finish !== null && !point(r.finish))) throw new Error('Place a start first.');
  if (!(typeof r.distance === 'number' && r.distance >= 500 && r.distance <= 300_000)) throw new Error('Choose a distance from 0.5 to 300 km.');
  if (r.climb !== null && !(typeof r.climb === 'number' && r.climb >= 0 && r.climb <= 10_000)) throw new Error('Choose climbing from 0 to 10,000 m, or leave it empty.');
  if (!['little', 'some', 'lots'].includes(r.newTrail)) throw new Error('Choose how much new trail.');
  const kinds = Array.isArray(r.kinds) ? r.kinds.filter((k: unknown) => KINDS.some((y) => y.kind === k)) : [];
  if (!kinds.length) throw new Error('Choose at least one kind of path.');
  if (r.maxDown != null && !(typeof r.maxDown === 'number' && r.maxDown >= 1 && r.maxDown <= 100)) throw new Error('Choose a steepest descent from 1 to 100%, or leave it empty.');
  if (r.maxUp != null && !(typeof r.maxUp === 'number' && r.maxUp >= 1 && r.maxUp <= 100)) throw new Error('Choose a steepest climb from 1 to 100%, or leave it empty.');
  if (r.tolerance != null && !(typeof r.tolerance === 'number' && r.tolerance >= 0 && r.tolerance <= 100_000)) throw new Error('Choose how far off the distance may be, from 0 to 100 km.');
  const more = planMore(o);
  const request: PlanRequest = {
    start: r.start, finish: r.finish, distance: r.distance, climb: r.climb, newTrail: r.newTrail, kinds, allowRestricted: r.allowRestricted === true,
    maxDown: r.maxDown ?? null, maxUp: r.maxUp ?? null, variant: more.variant, favorites: r.favorites === true, tolerance: r.tolerance ?? null,
    descent: descentOf(r.descent),
  };
  return { key, request, seen: more.seen, difficulty: more.difficulty };
}

/** A request for magic routes from the window, checked, as the planMagic job takes it. */
export function planMagicJob(key: unknown, x: unknown, o: unknown): { key: string; request: MagicRequest; seen: string[] } {
  const r = x as any;
  if (typeof key !== 'string' || !r || !point(r.start) || (r.finish !== null && !point(r.finish))) throw new Error('Place a start first.');
  if (!(typeof r.distance === 'number' && r.distance >= 500 && r.distance <= 300_000)) throw new Error('Choose a distance from 0.5 to 300 km.');
  if (!(typeof r.tolerance === 'number' && r.tolerance >= 0 && r.tolerance <= 100_000)) throw new Error('Choose how far off the distance may be, from 0 to 100 km.');
  if (!(r.difficulty in MAGIC)) throw new Error('Choose a difficulty for magic routes.');
  const more = planMore(o);
  return { key, request: { start: r.start, finish: r.finish, distance: r.distance, tolerance: r.tolerance, difficulty: r.difficulty, variant: more.variant, favorites: r.favorites === true, descent: descentOf(r.descent) }, seen: more.seen };
}
