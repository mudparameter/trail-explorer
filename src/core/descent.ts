// Long descents: one continuous stretch of path that keeps going down, for routes
// asked to include one. A descent may climb a little on the way, but never more
// than a set height above the lowest point so far, and it must drop at least a
// set share of its length on average. No Electron or DOM code here.
//
// The search goes from junction to lower junction: along one edge down, or over a
// crest no higher than the climb allowance and down again. Every junction it
// reaches is lower than the one before, so a stretch can never loop back on
// itself, and finding the longest descents is one pass over the junctions from
// highest to lowest.
import type { Network } from './network.ts';
import { elevated } from './route.ts';

export interface DescentWish {
  /** Metres. The descent is at least this long. */
  length: number;
  /** Metres. The most it may climb above the lowest point so far. */
  maxClimb: number;
  /** %, positive. The least it drops on average. */
  minGrade: number;
}
export const DESCENT_DEFAULTS = { maxClimb: 25, minGrade: 3 };
/** Roads not chosen for the route may still join trails in a descent, this long at most at a time. */
export const CONNECTOR = 500;

/** One way along an edge: edge index × 2 + 1 when going b→a, as the planner numbers them. */
type Dir = number;

export interface DescentStep {
  edge: number;
  back: boolean;
}
export interface Descent {
  steps: DescentStep[];
  /** Metres along it. */
  length: number;
  /** Metres from top to bottom. */
  drop: number;
  top: number;
  bottom: number;
}

/**
 * Stores heights on the network for finding descents: each junction's elevation,
 * and elevations every 10 m along each edge from a to b, as routes measure them.
 */
export function addHeights(net: Network, at: (lon: number, lat: number) => number) {
  for (const n of net.nodes) n.ele = at(n.lon, n.lat);
  for (const e of net.edges) {
    const line: [number, number][] = [];
    for (let k = 0; k < e.coords.length; k += 2) line.push([e.coords[k]!, e.coords[k + 1]!]);
    const raw = line.map(([x, y]) => at(x, y));
    // Unknown anywhere: the edge can't be shown to go down, so it is never part of a descent.
    e.heights = raw.every(Number.isFinite) ? elevated(line, at).map((p) => p[2]) : undefined;
  }
}

/** How an edge can be used in a descent going one way: not at all, as a path chosen for the route, or as a road joining trails. */
export type Use = 'no' | 'ok' | 'connector';

interface Label {
  len: number;
  /** Elevation where the descent started. */
  top: number;
  topNode: number;
  /** Lowest elevation so far. */
  low: number;
  /** Metres on the connecting road it is on now; 0 when on a chosen path. */
  road: number;
  /** The label it grew from, and the edges it took to get here. */
  from: Label | null;
  via: Dir[];
  node: number;
}

/** Labels kept per junction. More finds more descents, more slowly. */
const KEEP = 4;
/** A climb over a crest looks this far along paths, in metres and junctions, for a way down again. */
const CREST_LENGTH = 2000;
const CREST_NODES = 300;

/**
 * Descents at least `wish.length` long, as many as are found, and the length of
 * the longest descent of any length, for saying why when none is long enough.
 */
export function findDescents(net: Network, use: (dir: Dir) => Use, wish: DescentWish): { found: Descent[]; longest: number } {
  const { nodes, edges } = net;
  const g = wish.minGrade / 100;
  const ele = (n: number) => nodes[n]!.ele ?? NaN;
  /** Heights along an edge, going its way. The reversed ones are made once. */
  const back: (number[] | undefined)[] = [];
  const along = (d: Dir) => {
    const h = edges[d >> 1]!.heights!;
    return d & 1 ? (back[d >> 1] ??= [...h].reverse()) : h;
  };
  const from = (d: Dir) => (d & 1 ? edges[d >> 1]!.b : edges[d >> 1]!.a);
  const to = (d: Dir) => (d & 1 ? edges[d >> 1]!.a : edges[d >> 1]!.b);
  const usable = (d: Dir) => edges[d >> 1]!.heights !== undefined && Number.isFinite(ele(from(d))) && Number.isFinite(ele(to(d))) && use(d) !== 'no';

  // Ways on from each junction u: the shortest way to each lower junction, through
  // junctions no lower than u and at most the climb allowance above it. Most are one
  // edge down; the rest climb over a crest, across as many junctions as it takes.
  const adj: Dir[][] = nodes.map(() => []);
  edges.forEach((e, i) => {
    adj[e.a]!.push(i * 2);
    adj[e.b]!.push(i * 2 + 1);
  });
  const out: Dir[][][] = nodes.map((_, u) => {
    const base = ele(u);
    if (!Number.isFinite(base)) return [];
    const ways: Dir[][] = [];
    const dist = new Map<number, number>([[u, 0]]);
    const via = new Map<number, Dir>();
    const exits = new Set<number>();
    const heap = new MinHeap();
    heap.push(0, u);
    let settled = 0;
    while (heap.size && settled < CREST_NODES) {
      const [dn, n] = heap.pop();
      if (dn > dist.get(n)!) continue;
      settled++;
      if (exits.has(n)) {
        const path: Dir[] = [];
        for (let m = n; m !== u; m = from(via.get(m)!)) path.unshift(via.get(m)!);
        ways.push(path);
        continue;
      }
      for (const d of adj[n]!) {
        if (!usable(d)) continue;
        const m = to(d);
        const h = ele(m);
        // Lower than u: a way on. Otherwise only within the climb allowance above u.
        if (h >= base && h - base > wish.maxClimb) continue;
        const dm = dn + edges[d >> 1]!.len;
        if (dm > CREST_LENGTH && h >= base) continue;
        if (dm < (dist.get(m) ?? Infinity)) {
          dist.set(m, dm);
          via.set(m, d);
          if (h < base) exits.add(m);
          heap.push(dm, m);
        }
      }
    }
    return ways;
  });

  /** A label carried along one edge, or null if that breaks a rule. */
  const extend = (l: Label, d: Dir): Label | null => {
    const kind = use(d);
    // A descent starts and ends on a chosen path; roads only join them.
    if (kind === 'connector' && l.len === 0) return null;
    const road = kind === 'connector' ? l.road + edges[d >> 1]!.len : 0;
    if (road > CONNECTOR) return null;
    let low = l.low;
    for (const h of along(d)) {
      if (h - low > wish.maxClimb) return null;
      low = Math.min(low, h);
    }
    return { len: l.len + edges[d >> 1]!.len, top: l.top, topNode: l.topNode, low, road, from: l, via: [d], node: to(d) };
  };
  /**
   * Whether a descent has already been through junction `w`. Junctions get lower
   * along it, and a crest is never lower than where its climb began, so only the
   * stretch since the descent was last above `w` needs looking at.
   */
  const passed = (l: Label, w: number): boolean => {
    for (let x: Label | null = l; x; x = x.from) {
      if (x.node === w) return true;
      if (ele(x.node) > ele(w)) return false;
      for (let i = 0; i < x.via.length - 1; i++) if (to(x.via[i]!) === w) return true;
    }
    return false;
  };
  /** How far it is ahead of the least average drop, in metres. Negative when not steep enough yet. */
  const spare = (l: Label) => l.top - ele(l.node) - g * l.len;

  const labels: Label[][] = nodes.map(() => []);
  const order = nodes.map((_, i) => i).filter((i) => Number.isFinite(ele(i))).sort((a, b) => ele(b) - ele(a) || a - b);
  const ends: Label[] = [];
  let longest = 0;
  for (const u of order) {
    // Every junction can be the top of a descent.
    const here = keep([...labels[u]!, { len: 0, top: ele(u), topNode: u, low: ele(u), road: 0, from: null, via: [], node: u }], spare);
    labels[u] = here;
    for (const l of here) {
      if (l.len > 0 && l.road === 0 && spare(l) >= 0) {
        longest = Math.max(longest, l.len);
        if (l.len >= wish.length) ends.push(l);
      }
    }
    for (const way of out[u]!) {
      for (const l of here) {
        let x: Label | null = l;
        for (const d of way) x = x && extend(x, d);
        if (!x) continue;
        // A climb over a crest must not lead back onto the descent so far.
        if (way.length > 1 && way.some((d, i) => i < way.length - 1 && passed(l, to(d)))) continue;
        x.from = l;
        x.via = way;
        labels[x.node]!.push(x);
      }
    }
  }

  // Closest to the length asked for first, each one different from those before.
  ends.sort((a, b) => a.len - b.len || spare(b) - spare(a));
  const found: Descent[] = [];
  const taken = new Set<number>();
  for (const l of ends) {
    if (found.length >= 12) break;
    const steps = stepsOf(l);
    const ids = steps.map((s) => s.edge);
    if (new Set(ids).size !== ids.length) continue;
    const shared = ids.filter((i) => taken.has(i)).reduce((n, i) => n + edges[i]!.len, 0);
    if (shared > l.len / 2) continue;
    for (const i of ids) taken.add(i);
    found.push({ steps, length: l.len, drop: l.top - ele(l.node), top: l.topNode, bottom: l.node });
  }
  return { found, longest };
}

/** The best few labels: the longest that are steep enough, then the most ahead on drop, then the most room to climb. */
function keep(ls: Label[], spare: (l: Label) => number): Label[] {
  if (ls.length <= KEEP) return ls;
  const out = new Set<Label>();
  const ok = ls.filter((l) => spare(l) >= 0 && l.road === 0).sort((a, b) => b.len - a.len);
  for (const l of ok.slice(0, 2)) out.add(l);
  for (const l of [...ls].sort((a, b) => b.len - a.len).slice(0, 1)) out.add(l);
  for (const l of [...ls].sort((a, b) => spare(b) - spare(a))) {
    if (out.size >= KEEP - 1) break;
    out.add(l);
  }
  for (const l of [...ls].sort((a, b) => b.low - a.low || b.len - a.len)) {
    if (out.size >= KEEP) break;
    out.add(l);
  }
  return [...out];
}

function stepsOf(l: Label): DescentStep[] {
  const dirs: Dir[] = [];
  for (let x: Label | null = l; x && x.from; x = x.from) dirs.unshift(...x.via);
  return dirs.map((d) => ({ edge: d >> 1, back: (d & 1) === 1 }));
}

/** The smallest key first; ties by the smaller value, so the search is the same every time. */
class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  private less(i: number, j: number) {
    return this.k[i]! < this.k[j]! || (this.k[i] === this.k[j] && this.v[i]! < this.v[j]!);
  }
  private swap(i: number, j: number) {
    [this.k[i], this.k[j]] = [this.k[j]!, this.k[i]!];
    [this.v[i], this.v[j]] = [this.v[j]!, this.v[i]!];
  }
  push(key: number, val: number) {
    this.k.push(key);
    this.v.push(val);
    for (let i = this.k.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.k[0]!, this.v[0]!];
    const last = this.k.length - 1;
    this.swap(0, last);
    this.k.pop();
    this.v.pop();
    for (let i = 0; ; ) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < this.k.length && this.less(l, m)) m = l;
      if (r < this.k.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}
