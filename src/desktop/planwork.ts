// Route planning jobs, run in the worker process. The network for the chosen
// areas is built once and kept here, so trying different requests is quick.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection } from 'geojson';
import { buildNetwork, coverage, networkGeoJson, RideIndex, type Network } from '../core/network.ts';
import type { Shape } from '../core/shapes.ts';
import { favoriteEdges, MAGIC, overlap, Planner, type MagicRequest, type Planned, type PlanRequest } from '../core/planner.ts';
import { describe, elevated, statsOfLine, steepestDescents, type Difficulty, type PlannedRoute } from '../core/route.ts';
import type { OsmWay } from '../core/roads.ts';
import { addHeights } from '../core/descent.ts';
import { decodeTerrarium, Elevation, TERRAIN_ZOOM } from '../core/terrain.ts';
import { unpackTrack } from '../core/track.ts';

export interface NetworkJob {
  key: string;
  ways: OsmWay[];
  shapes: Shape[];
  /** Packed tracks of the rides that count as ridden. */
  tracks: Float64Array[];
  bounds: [number, number, number, number];
  terrainDir: string;
}
export interface NetworkResult {
  geojson: FeatureCollection;
  total: number;
  ridden: number;
}

let current: { key: string; net: Network; terrainDir: string } | null = null;

/** Decoded elevation tiles, most recent last. About 260 kB each. */
const tiles = new Map<string, Float32Array | null>();
const MAX_TILES = 300;
function elevation(dir: string) {
  return new Elevation((x, y) => {
    const file = join(dir, String(TERRAIN_ZOOM), String(x), `${y}.png`);
    let t = tiles.get(file);
    if (t === undefined) {
      try {
        t = decodeTerrarium(readFileSync(file));
      } catch {
        t = null;
      }
      if (tiles.size >= MAX_TILES) tiles.delete(tiles.keys().next().value!);
    } else tiles.delete(file);
    tiles.set(file, t);
    return t;
  });
}

export function network(job: NetworkJob): NetworkResult {
  const lines = job.tracks.flatMap((t) => unpackTrack(t));
  const index = new RideIndex(lines, job.bounds);
  const net = buildNetwork(job.ways, job.shapes, index.ridden, index.passes);
  // How steep each path is going down either way, so a limit on descents can leave it out.
  const ele = elevation(job.terrainDir);
  const at = (lon: number, lat: number) => ele.at(lon, lat);
  for (const e of net.edges) {
    const line: [number, number][] = [];
    for (let k = 0; k < e.coords.length; k += 2) line.push([e.coords[k]!, e.coords[k + 1]!]);
    e.down = steepestDescents(line, at);
  }
  // Heights for finding long descents, when a route asks for one.
  addHeights(net, at);
  current = { key: job.key, net, terrainDir: job.terrainDir };
  return { geojson: networkGeoJson(net), ...coverage(net) };
}

const routeId = (p: Planned) => createHash('sha256').update(JSON.stringify(p.steps)).digest('hex').replace(/[^a-z0-9]/g, '').slice(0, 12);
const LEVELS: Difficulty[] = ['Easy', 'Moderate', 'Hard', 'Very hard'];

function ready(key: string) {
  if (!current || current.key !== key) throw new Error('The areas need preparing again. Go back to step 1.');
  const ele = elevation(current.terrainDir);
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
