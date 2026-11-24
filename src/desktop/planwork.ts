// Route planning jobs, run in the worker process. The network for the chosen
// areas is built once and kept here, so trying different requests is quick.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection } from 'geojson';
import { buildNetwork, coverage, networkGeoJson, RideIndex, type Circle, type Network } from '../core/network.ts';
import { Planner, type Planned, type PlanRequest } from '../core/planner.ts';
import { describe, elevated, statsOfLine, type PlannedRoute } from '../core/route.ts';
import type { OsmWay } from '../core/roads.ts';
import { decodeTerrarium, Elevation, TERRAIN_ZOOM } from '../core/terrain.ts';
import { unpackTrack } from '../core/track.ts';

export interface NetworkJob {
  key: string;
  ways: OsmWay[];
  circles: Circle[];
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
  const net = buildNetwork(job.ways, job.circles, index.ridden);
  current = { key: job.key, net, terrainDir: job.terrainDir };
  return { geojson: networkGeoJson(net), ...coverage(net) };
}

export function routes({ key, request }: { key: string; request: PlanRequest }): PlannedRoute[] {
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
  const planned = new Planner(current.net, request).plan(5, climbOf);
  return planned.map((p) => {
    const id = createHash('sha256').update(JSON.stringify(p.steps)).digest('hex').replace(/[^a-z0-9]/g, '').slice(0, 12);
    return describe(p, at, request.finish === null, id);
  });
}
