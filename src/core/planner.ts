// Plans routes on a Network: loops from one point, or routes between two, near a
// wished-for distance, mixing trails you have ridden with ones you haven't.
// Everything here is deterministic: the same network and request always give
// the same routes. No Electron or DOM code here.
import type { Edge, Network } from './network.ts';
import type { RoadKind } from './roads.ts';
import { metres, M_PER_DEG } from './track.ts';

export type NewTrail = 'little' | 'some' | 'lots';

export interface PlanRequest {
  start: [number, number];
  /** Null for a loop back to the start. */
  finish: [number, number] | null;
  /** Metres. */
  distance: number;
  /** Metres of climbing wished for, if any. */
  climb: number | null;
  newTrail: NewTrail;
  /** Kinds of road the route may use. */
  kinds: RoadKind[];
  /** Use trails marked private or no bikes. */
  allowRestricted: boolean;
  /** Steepest descent allowed, in %. Null for any. Climbing a path steeper than this is fine. */
  maxDown?: number | null;
  /** Steepest climb allowed, in %. Null for any. Riding down a path steeper than this is fine. */
  maxUp?: number | null;
  /** Most technical path allowed, on the 0–6 mtb:scale. Untagged paths are always allowed. Null for any. */
  maxLevel?: number | null;
  /**
   * 0 for the usual routes. Each other number turns the shapes and nudges path
   * choices a different way, for a fresh set from the same request. Still the same every time.
   */
  variant?: number;
  /** Take in your favourite trails: the ones you have ridden most in these areas. */
  favorites?: boolean;
}

/** Favourite trails cost this much less per metre, so routes go out of their way for them. */
const FAVORITE_COST = 0.35;

/**
 * Your favourite trails in a network: edges ridden at least twice, and either in
 * the most-ridden fifth of what you have ridden there (by length) or ridden at
 * least half as often as your most-ridden one. Edge indexes.
 */
export function favoriteEdges(net: Network): Set<number> {
  const ridden = net.edges.map((e, i) => ({ i, n: e.ridden >= 0.5 ? (e.passes ?? 0) : 0, len: e.len })).filter((x) => x.n >= 2);
  if (!ridden.length) return new Set();
  const total = ridden.reduce((s, x) => s + x.len, 0);
  ridden.sort((a, b) => b.n - a.n || a.i - b.i);
  // The most-ridden fifth by length, and everything ridden as often as its last edge.
  let sum = 0, cut = ridden[0]!.n;
  for (const x of ridden) {
    if (sum >= total * 0.2) break;
    sum += x.len;
    cut = x.n;
  }
  const min = Math.max(2, Math.min(cut, Math.ceil(ridden[0]!.n / 2)));
  return new Set(ridden.filter((x) => x.n >= min).map((x) => x.i));
}

/** A number from 0 to 1 from two integers, always the same for the same two. */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export type Level = 'Easy' | 'Moderate' | 'Hard' | 'Very hard';

/** What the magic planner asks for: only a place, a distance and a difficulty. */
export interface MagicRequest {
  start: [number, number];
  finish: [number, number] | null;
  distance: number;
  /** Metres either side of the distance that are fine. */
  tolerance: number;
  difficulty: Level;
  variant?: number;
  /** Take in your favourite trails, as with planning by hand. */
  favorites?: boolean;
}

/**
 * What suits each difficulty, for the magic planner: the steepest climbs and
 * descents, the most technical paths (mtb:scale), and about how much climbing per km.
 * These match the ratings routes are given, so a route made with them rates as asked.
 */
export const MAGIC: Record<Level, { maxUp: number | null; maxDown: number | null; maxLevel: number | null; climbPerKm: number }> = {
  // Ratings count climbs from 15% and 20%, and descents from 20% and 28%: each
  // difficulty allows the steepness that earns it, and nothing steeper.
  Easy: { maxUp: 12, maxDown: 14, maxLevel: 1, climbPerKm: 12 },
  Moderate: { maxUp: 19, maxDown: 22, maxLevel: 2, climbPerKm: 24 },
  Hard: { maxUp: 27, maxDown: 32, maxLevel: 3, climbPerKm: 34 },
  'Very hard': { maxUp: null, maxDown: null, maxLevel: null, climbPerKm: 45 },
};

/** How each choice of new trail weighs unridden trail, and the share of the route it aims for. */
const NEW: Record<NewTrail, { discount: number; aim: [number, number]; target: number }> = {
  little: { discount: 1.15, aim: [0.05, 0.3], target: 0.15 },
  some: { discount: 0.9, aim: [0.25, 0.55], target: 0.4 },
  lots: { discount: 0.6, aim: [0.45, 0.85], target: 0.75 },
};
/** Roads are fine for joining trails up, but not for whole routes. */
const KIND_COST: Record<RoadKind, number> = { trail: 1, track: 1.05, cycleway: 1.15, road: 1.6 };
/** Using an edge twice in one route costs this much more, so routes don't double back. */
const REUSE = 4;

export interface Step {
  edge: number;
  /** Travelled from b to a. */
  back: boolean;
}

export interface Planned {
  /** The edges in order. */
  steps: Step[];
  /** lon, lat per point along the route. */
  line: [number, number][];
  distance: number;
  /** Metres on trail you haven't ridden. */
  fresh: number;
  /** Metres on edges used more than once. */
  repeated: number;
  kinds: Partial<Record<RoadKind, number>>;
  /** Highest mtb:scale or sac_scale on the route. */
  level: number | null;
  /** Metres on your favourite trails, counted once. */
  favorite: number;
  restricted: boolean;
  /** Compass direction of the route's middle from the start, for its name. */
  heading: string;
}

// --- graph search -------------------------------------------------------------------

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i) {
      const p = (i - 1) >> 1;
      if (k[p]! <= key) break;
      k[i] = k[p]!;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v;
    const top = v[0]!;
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1]! < k[c]!) c++;
        if (k[c]! >= lk) break;
        k[i] = k[c]!;
        v[i] = v[c]!;
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

export class Planner {
  readonly net: Network;
  private req: PlanRequest;
  /** For node i: edge index × 2 + (1 if leaving by b). */
  private adj: number[][];
  /** Cost per edge direction: [a→b, b→a]. Infinity where not allowed. */
  private cost: Float64Array;
  /** The cheapest cost per metre, for the A* estimate. */
  private cheapest: number;
  /** Nodes reachable from the start. */
  private reach: Set<number> = new Set();
  /** Reachable nodes on a trail you haven't ridden. */
  private fresh: Set<number> = new Set();
  private startNode: number;
  /** Favourite edges, when asked for. */
  private favs: Set<number>;
  private favLength = 0;

  constructor(net: Network, req: PlanRequest) {
    this.net = net;
    this.req = req;
    const { discount } = NEW[req.newTrail];
    this.favs = req.favorites ? favoriteEdges(net) : new Set();
    this.favLength = [...this.favs].reduce((n, i) => n + net.edges[i]!.len, 0);
    this.adj = net.nodes.map(() => []);
    this.cost = new Float64Array(net.edges.length * 2);
    let cheapest = Infinity;
    net.edges.forEach((e, i) => {
      const tooHard = req.maxLevel != null && e.level !== null && e.level > req.maxLevel;
      const ok = req.kinds.includes(e.kind) && (req.allowRestricted || !e.restricted) && !tooHard;
      // Another variant weighs each path a little differently, so the search finds other ways.
      const jitter = req.variant ? 1 + 0.6 * hash01(i, req.variant) : 1;
      const fav = this.favs.has(i) ? FAVORITE_COST : 1;
      const c = ok ? e.len * KIND_COST[e.kind] * (e.ridden + (1 - e.ridden) * discount) * jitter * fav : Infinity;
      // Too steep to ride down, or up, that way. Climbing one way is descending the
      // other, so the descent going back is the climb. Unknown elevation (NaN) never rules a path out.
      const maxDown = req.maxDown ?? null, maxUp = req.maxUp ?? null;
      const steep = (way: 0 | 1) => !!e.down && ((maxDown !== null && e.down[way] > maxDown) || (maxUp !== null && e.down[1 - way]! > maxUp));
      this.cost[i * 2] = e.oneway === -1 || steep(0) ? Infinity : c;
      this.cost[i * 2 + 1] = e.oneway === 1 || steep(1) ? Infinity : c;
      if (ok) cheapest = Math.min(cheapest, c / e.len);
      this.adj[e.a]!.push(i * 2);
      this.adj[e.b]!.push(i * 2 + 1);
    });
    this.cheapest = Number.isFinite(cheapest) ? cheapest : 1;
    this.startNode = this.nearest(req.start, null);
    if (this.startNode < 0) throw new Error('There are no paths you can use near the start. Try another kind of path, or a point inside an area.');
    // What can be reached from the start, so waypoints are never cut off.
    const stack = [this.startNode];
    this.reach.add(this.startNode);
    while (stack.length) {
      const n = stack.pop()!;
      for (const ed of this.adj[n]!) {
        if (!Number.isFinite(this.cost[ed]!)) continue;
        const e = net.edges[ed >> 1]!;
        const to = ed & 1 ? e.a : e.b;
        if (!this.reach.has(to)) {
          this.reach.add(to);
          stack.push(to);
        }
      }
    }
    for (const n of this.reach) {
      if (this.adj[n]!.some((ed) => Number.isFinite(this.cost[ed]!) && net.edges[ed >> 1]!.ridden < 0.5)) this.fresh.add(n);
    }
  }

  /** The node nearest a point, among those `among` allows (any with an allowed edge, if null). */
  private nearest([lon, lat]: [number, number], among: Set<number> | null): number {
    let best = -1, bestD = Infinity;
    const k = Math.cos((lat * Math.PI) / 180);
    this.net.nodes.forEach((p, i) => {
      if (among ? !among.has(i) : !this.adj[i]!.some((ed) => Number.isFinite(this.cost[ed]!) || Number.isFinite(this.cost[ed ^ 1]!))) return;
      const d = ((p.lon - lon) * k) ** 2 + (p.lat - lat) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** A* from one node to another. `used` edges cost REUSE times more. */
  private path(from: number, to: number, used: Set<number>): Step[] | null {
    if (from === to) return [];
    const { nodes, edges } = this.net;
    const goal = nodes[to]!;
    const k = Math.cos((goal.lat * Math.PI) / 180);
    const h = (n: number) => Math.hypot((nodes[n]!.lon - goal.lon) * k, nodes[n]!.lat - goal.lat) * M_PER_DEG * this.cheapest;
    const g = new Map<number, number>([[from, 0]]);
    const via = new Map<number, number>();
    const done = new Set<number>();
    const heap = new Heap();
    heap.push(h(from), from);
    while (heap.size) {
      const n = heap.pop();
      if (done.has(n)) continue;
      if (n === to) break;
      done.add(n);
      const gn = g.get(n)!;
      for (const ed of this.adj[n]!) {
        let c = this.cost[ed]!;
        if (!Number.isFinite(c)) continue;
        if (used.has(ed >> 1)) c *= REUSE;
        const e = edges[ed >> 1]!;
        const m = ed & 1 ? e.a : e.b;
        const gm = gn + c;
        if (gm < (g.get(m) ?? Infinity)) {
          g.set(m, gm);
          via.set(m, ed);
          heap.push(gm + h(m), m);
        }
      }
    }
    if (!via.has(to)) return null;
    const out: Step[] = [];
    for (let n = to; n !== from; ) {
      const ed = via.get(n)!;
      const e = edges[ed >> 1]!;
      out.push({ edge: ed >> 1, back: (ed & 1) === 1 });
      n = ed & 1 ? e.b : e.a;
    }
    return out.reverse();
  }

  /** A route through points in order, or null if a leg can't be made. */
  private through(points: number[]): Step[] | null {
    const steps: Step[] = [];
    const used = new Set<number>();
    for (let i = 1; i < points.length; i++) {
      const leg = this.path(points[i - 1]!, points[i]!, used);
      if (!leg) return null;
      for (const s of leg) {
        steps.push(s);
        used.add(s.edge);
      }
    }
    return dropSpurs(steps);
  }

  /**
   * A waypoint near a place: the nearest reachable junction, or with lots of new
   * trail wished for, the nearest one on a trail you haven't ridden, if there is one close.
   */
  private waypoint(p: [number, number], within: number): number {
    const any = this.nearest(p, this.reach);
    if (this.req.newTrail !== 'lots') return any;
    const f = this.nearest(p, this.fresh);
    if (f < 0) return any;
    const a = this.net.nodes[any]!, b = this.net.nodes[f]!;
    return metres(p[0], p[1], b.lon, b.lat) - metres(p[0], p[1], a.lon, a.lat) <= within ? f : any;
  }

  private summary(steps: Step[]): Planned {
    const { edges, nodes } = this.net;
    const line: [number, number][] = [];
    const count = new Map<number, number>();
    const kinds: Partial<Record<RoadKind, number>> = {};
    let distance = 0, fresh = 0, repeated = 0, favorite = 0, level: number | null = null, restricted = false;
    for (const { edge, back } of steps) {
      const e = edges[edge]!;
      const pts: [number, number][] = [];
      for (let k = 0; k < e.coords.length; k += 2) pts.push([e.coords[k]!, e.coords[k + 1]!]);
      if (back) pts.reverse();
      line.push(...(line.length ? pts.slice(1) : pts));
      const seen = count.get(edge) ?? 0;
      count.set(edge, seen + 1);
      distance += e.len;
      if (seen) repeated += e.len;
      else {
        fresh += e.len * (1 - e.ridden);
        if (this.favs.has(edge)) favorite += e.len;
      }
      kinds[e.kind] = (kinds[e.kind] ?? 0) + e.len;
      if (e.level !== null) level = Math.max(level ?? 0, e.level);
      if (e.restricted) restricted = true;
    }
    const s = nodes[this.startNode]!;
    const mid = line[Math.floor(line.length / 2)] ?? [s.lon, s.lat];
    return { steps, line, distance, fresh, repeated, favorite, kinds, level, restricted, heading: compass(s.lon, s.lat, mid[0], mid[1]) };
  }

  /** Up to `count` different routes for the request, best first. */
  plan(count = 5, climbOf?: (p: Planned) => number): Planned[] {
    const { start, finish, distance } = this.req;
    const s = this.startNode;
    const f = finish ? this.nearest(finish, this.reach) : s;
    if (f < 0) throw new Error('The finish cannot be reached from the start on the paths chosen.');
    const sp = this.net.nodes[s]!;
    const fp = this.net.nodes[f]!;
    const candidates: Planned[] = [];
    const tried = new Set<string>();
    const attempt = (points: number[]) => {
      const key = points.join(',');
      if (tried.has(key)) return null;
      tried.add(key);
      const steps = this.through(points);
      return steps && steps.length ? this.summary(steps) : null;
    };

    // Shapes, each grown or shrunk a few times until it is near the distance.
    // Another variant turns them part of the way round, so they reach other places.
    const variant = this.req.variant ?? 0;
    const turn = variant ? (hash01(variant, 7) - 0.5) * (Math.PI / 4) + variant * 0.3 : 0;
    const shapes: ((scale: number) => [number, number][])[] = [];
    if (!finish) {
      for (let i = 0; i < 8; i++) {
        const b = (i * Math.PI) / 4 + turn;
        // A triangle out and back…
        shapes.push((r) => [offset(start, b - 0.6, r), offset(start, b + 0.6, r)]);
        // …and a wider, rounder loop.
        shapes.push((r) => [offset(start, b - 0.8, r * 0.8), offset(start, b, r * 1.1), offset(start, b + 0.8, r * 0.8)]);
      }
    } else {
      const direct = metres(sp.lon, sp.lat, fp.lon, fp.lat);
      const b = Math.atan2((fp.lon - sp.lon) * Math.cos((sp.lat * Math.PI) / 180), fp.lat - sp.lat) + turn / 3;
      const mid: [number, number] = [(sp.lon + fp.lon) / 2, (sp.lat + fp.lat) / 2];
      shapes.push(() => []);
      for (const side of [-1, 1]) {
        shapes.push((r) => [offset(mid, b + (side * Math.PI) / 2, r)]);
        shapes.push((r) => [offset(offset(start, b, direct / 4), b + (side * Math.PI) / 2, r), offset(offset(start, b, (direct * 3) / 4), b + (side * Math.PI) / 2, r)]);
      }
    }
    // Shapes through favourite trails, so routes reach them even when the usual shapes don't pass by.
    for (const [a, b] of this.favoriteRuns(distance)) {
      if (!finish) {
        // Out to the stretch, along it, and round by a third place sized to the distance.
        const far = Math.atan2((b[0] - start[0]) * Math.cos((start[1] * Math.PI) / 180), b[1] - start[1]);
        // The third place goes several ways round, so a route can take in the stretch and other ground too.
        for (const k of [0.9, 1.8, Math.PI]) {
          shapes.push((r) => [a, b, offset(start, far + k + turn, r)]);
          shapes.push((r) => [offset(start, far - k + turn, r), b, a]);
        }
        shapes.push(() => [a, b]);
      } else shapes.push(() => [a, b]);
    }
    for (const shape of shapes) {
      // First guess: paths wind, so a shape is about a third longer on the ground.
      let r = (variant ? 0.85 + 0.3 * hash01(variant, shapes.indexOf(shape)) : 1) * (finish ? Math.sqrt(Math.max(0, (distance / 1.3 / 2) ** 2 - (metres(sp.lon, sp.lat, fp.lon, fp.lat) / 2) ** 2)) : distance / 1.3 / 3.2);
      let best: Planned | null = null;
      for (let tries = 0; tries < 4; tries++) {
        const via = shape(r).map((p) => this.waypoint(p, Math.max(150, r / 8)));
        const p = attempt([s, ...via, f]);
        if (p && (!best || Math.abs(p.distance - distance) < Math.abs(best.distance - distance))) best = p;
        if (!p || Math.abs(p.distance - distance) / distance < 0.08 || !shape(1).length) break;
        r *= Math.max(0.5, Math.min(2, distance / p.distance));
      }
      if (best) candidates.push(best);
    }
    return this.pick(candidates, count, climbOf);
  }

  /**
   * Stretches of favourite trail to ride along, as the places at each end: the
   * favourite edges joined into runs, each cut to at most a third of the
   * distance, nearest the start first. Routing through both ends rides the stretch.
   */
  private favoriteRuns(distance: number): [[number, number], [number, number]][] {
    if (!this.favs.size) return [];
    const { edges, nodes } = this.net;
    const s = nodes[this.startNode]!;
    // Favourite edges by node, to walk along runs.
    const at = new Map<number, number[]>();
    for (const i of this.favs) {
      const e = edges[i]!;
      if (!this.reach.has(e.a)) continue;
      for (const n of [e.a, e.b]) at.set(n, [...(at.get(n) ?? []), i]);
    }
    const used = new Set<number>();
    const runs: { nodes: number[]; len: number }[] = [];
    for (const first of [...this.favs].sort((a, b) => a - b)) {
      if (used.has(first) || !at.has(edges[first]!.a)) continue;
      // Grow both ways from this edge while there is exactly one way on, so a run is one line.
      used.add(first);
      let line = [edges[first]!.a, edges[first]!.b];
      let len = edges[first]!.len;
      for (const end of [1, 0]) {
        for (;;) {
          const n = end ? line[line.length - 1]! : line[0]!;
          const next = (at.get(n) ?? []).filter((i) => !used.has(i));
          if (next.length !== 1) break;
          const e = edges[next[0]!]!;
          used.add(next[0]!);
          const other = e.a === n ? e.b : e.a;
          if (line.includes(other)) break;
          line = end ? [...line, other] : [other, ...line];
          len += e.len;
        }
      }
      runs.push({ nodes: line, len });
    }
    const near = (n: number) => metres(s.lon, s.lat, nodes[n]!.lon, nodes[n]!.lat);
    const out: [[number, number], [number, number]][] = [];
    for (const r of runs.sort((a, b) => b.len - a.len)) {
      if (r.len < 100) continue;
      // Join it where it is nearest the start, ride the way with more of it, and stop at a third of the distance.
      let m = 0;
      r.nodes.forEach((n, i) => { if (near(n) < near(r.nodes[m]!)) m = i; });
      const ns = m >= (r.nodes.length - 1) / 2 ? r.nodes.slice(0, m + 1).reverse() : r.nodes.slice(m);
      if (ns.length < 2 || near(ns[0]!) > distance / 2.5) continue;
      let k = 1, done = 0;
      for (; k < ns.length - 1; k++) {
        done += metres(nodes[ns[k - 1]!]!.lon, nodes[ns[k - 1]!]!.lat, nodes[ns[k]!]!.lon, nodes[ns[k]!]!.lat);
        if (done >= distance / 3) break;
      }
      const a = nodes[ns[0]!]!, b = nodes[ns[k]!]!;
      out.push([[a.lon, a.lat], [b.lon, b.lat]]);
      if (out.length >= 3) break;
    }
    return out;
  }

  /** The best routes that are not too alike. */
  private pick(all: Planned[], count: number, climbOf?: (p: Planned) => number): Planned[] {
    const { distance, climb, newTrail } = this.req;
    const { aim: [lo, hi], target } = NEW[newTrail];
    const score = (p: Planned) => {
      const share = p.fresh / p.distance;
      let s = 3 * Math.abs(p.distance - distance) / distance;
      // Some new trail each ride, not all of it: the area fills in over several.
      s += 4 * (share < lo ? lo - share : share > hi ? share - hi : 0) + 1.5 * Math.abs(share - target);
      s += 2 * (p.repeated / p.distance);
      // Asked for favourites: aim for about a quarter of the route on them (or all there are).
      if (this.favs.size) {
        const want = Math.min(p.distance / 4, this.favLength);
        s += 3 * Math.max(0, 1 - p.favorite / Math.max(want, 1));
      }
      if (climb !== null && climbOf) s += Math.abs(climbOf(p) - climb) / Math.max(climb, 100);
      return s;
    };
    const ranked = all.map((p) => ({ p, s: score(p) })).sort((a, b) => a.s - b.s || a.p.distance - b.p.distance);
    const out: Planned[] = [];
    for (const limit of [0.5, 0.75, 0.9]) {
      for (const { p } of ranked) {
        if (out.length >= count) break;
        if (out.includes(p) || out.some((q) => overlap(this.net.edges, p, q) > limit)) continue;
        out.push(p);
      }
      if (out.length >= Math.min(3, ranked.length)) break;
    }
    return out;
  }
}

/** Drops out-and-back spurs: where a route goes along an edge and straight back. */
function dropSpurs(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (last && last.edge === s.edge && last.back !== s.back) out.pop();
    else out.push(s);
  }
  return out;
}

/** The share of the shorter route's length that is on edges both use. */
export function overlap(edges: Edge[], a: Planned, b: Planned): number {
  const inB = new Set(b.steps.map((s) => s.edge));
  let shared = 0;
  for (const e of new Set(a.steps.map((s) => s.edge))) if (inB.has(e)) shared += edges[e]!.len;
  return shared / Math.min(a.distance, b.distance);
}

/** A point `m` metres from `p` along bearing `b` (radians from north). */
function offset(p: [number, number], b: number, m: number): [number, number] {
  return [p[0] + (Math.sin(b) * m) / (M_PER_DEG * Math.cos((p[1] * Math.PI) / 180)), p[1] + (Math.cos(b) * m) / M_PER_DEG];
}

const POINTS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
function compass(lon0: number, lat0: number, lon1: number, lat1: number): string {
  const b = Math.atan2((lon1 - lon0) * Math.cos((lat0 * Math.PI) / 180), lat1 - lat0);
  return POINTS[(Math.round(b / (Math.PI / 4)) + 8) % 8]!;
}
