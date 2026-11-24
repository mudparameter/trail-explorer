// The road and trail network inside chosen areas, as a graph for route
// planning: junctions joined by edges, each edge knowing its kind, whether bikes
// may use it, and how much of it you have ridden. No Electron or DOM code here.
import type { FeatureCollection } from 'geojson';
import { kindOf, type OsmWay, type RoadKind } from './roads.ts';
import { M_PER_DEG, metres } from './track.ts';

export interface Circle {
  center: [number, number];
  radius: number;
}

export interface Edge {
  /** Node indexes at each end. */
  a: number;
  b: number;
  /** lon, lat, lon, lat… from a to b. */
  coords: number[];
  /** Metres. */
  len: number;
  kind: RoadKind;
  name: string | null;
  surface: string | null;
  /** 0 to 6, from mtb:scale or sac_scale; null when not tagged. */
  level: number | null;
  /** Private, no entry, or no bikes. */
  restricted: boolean;
  /** 1: only a→b on a bike, -1: only b→a, 0: both. */
  oneway: 0 | 1 | -1;
  /** Share of the edge you have ridden, 0 to 1. */
  ridden: number;
}

export interface Network {
  nodes: { lon: number; lat: number }[];
  edges: Edge[];
}

export const insideAny = (circles: Circle[], lon: number, lat: number) => circles.some((c) => metres(c.center[0], c.center[1], lon, lat) <= c.radius);

/** Metres between the points checked along an edge for whether it is ridden. */
const SAMPLE = 10;

/** mtb:scale 0–6, or sac_scale mapped onto it. */
export function levelOf(t: Record<string, string>): number | null {
  const mtb = Number.parseInt(t['mtb:scale'] ?? '', 10);
  if (Number.isFinite(mtb)) return Math.max(0, Math.min(6, mtb));
  const sac = ['hiking', 'mountain_hiking', 'demanding_mountain_hiking', 'alpine_hiking', 'demanding_alpine_hiking', 'difficult_alpine_hiking'].indexOf(t.sac_scale ?? '');
  return sac >= 0 ? sac : null;
}

export function restrictedOf(t: Record<string, string>): boolean {
  const bike = t.bicycle ?? '';
  if (['no', 'private', 'dismount', 'use_sidepath'].includes(bike)) return true;
  if (['yes', 'designated', 'permissive'].includes(bike)) return false;
  return ['private', 'no'].includes(t.access ?? '');
}

function onewayOf(t: Record<string, string>): 0 | 1 | -1 {
  const ob = t['oneway:bicycle'];
  if (ob === 'no') return 0;
  const v = ob ?? t.oneway ?? '';
  return v === 'yes' || v === '1' || v === 'true' ? 1 : v === '-1' ? -1 : 0;
}

/**
 * Builds the network from downloaded ways, keeping only what is inside the
 * circles. Ways are split where they meet, so every junction is a node.
 * `ridden(lon, lat, bearing)` says whether you have ridden there, if known.
 */
export function buildNetwork(ways: OsmWay[], circles: Circle[], ridden?: (lon: number, lat: number, bearing: number) => boolean): Network {
  // Runs of consecutive nodes inside the circles.
  const runs: { way: OsmWay; kind: RoadKind; ids: number[]; pts: [number, number][] }[] = [];
  for (const way of ways) {
    const kind = kindOf(way.tags);
    if (!kind) continue;
    let ids: number[] = [];
    let pts: [number, number][] = [];
    const flush = () => {
      if (ids.length >= 2) runs.push({ way, kind, ids, pts });
      ids = [];
      pts = [];
    };
    way.coords.forEach((p, i) => {
      if (insideAny(circles, p[0], p[1])) {
        ids.push(way.nodes[i]!);
        pts.push(p);
      } else flush();
    });
    flush();
  }
  // Junctions: nodes on more than one run, or at the end of one.
  const seen = new Map<number, number>();
  for (const r of runs) {
    r.ids.forEach((id, i) => seen.set(id, (seen.get(id) ?? 0) + (i === 0 || i === r.ids.length - 1 ? 2 : 1)));
  }
  const nodes: Network['nodes'] = [];
  const index = new Map<number, number>();
  const nodeOf = (id: number, p: [number, number]) => {
    let i = index.get(id);
    if (i === undefined) {
      i = nodes.length;
      index.set(id, i);
      nodes.push({ lon: p[0], lat: p[1] });
    }
    return i;
  };
  const edges: Edge[] = [];
  for (const r of runs) {
    const t = r.way.tags;
    const base = {
      kind: r.kind, name: t.name ?? t.ref ?? null, surface: t.surface?.replace(/_/g, ' ') ?? null, level: levelOf(t),
      restricted: restrictedOf(t), oneway: onewayOf(t),
    };
    let start = 0;
    for (let i = 1; i < r.ids.length; i++) {
      if (i < r.ids.length - 1 && (seen.get(r.ids[i]!) ?? 0) < 2) continue;
      const pts = r.pts.slice(start, i + 1);
      let len = 0;
      for (let k = 1; k < pts.length; k++) len += metres(pts[k - 1]![0], pts[k - 1]![1], pts[k]![0], pts[k]![1]);
      if (len > 0) {
        edges.push({
          ...base, a: nodeOf(r.ids[start]!, pts[0]!), b: nodeOf(r.ids[i]!, pts[pts.length - 1]!),
          coords: pts.flat(), len, ridden: ridden ? riddenShare(pts, len, ridden) : 0,
        });
      }
      start = i;
    }
  }
  return { nodes, edges };
}

/** The share of points every SAMPLE metres along a line that you have ridden, going its way. */
function riddenShare(pts: [number, number][], len: number, ridden: (lon: number, lat: number, bearing: number) => boolean): number {
  let hit = 0, n = 0;
  walk(pts, Math.max(SAMPLE, len / 200), (lon, lat, bearing) => {
    n++;
    if (ridden(lon, lat, bearing)) hit++;
  });
  return n ? hit / n : 0;
}

/** Calls `fn` every `step` metres along a line, with the bearing there in radians. */
export function walk(pts: [number, number][], step: number, fn: (lon: number, lat: number, bearing: number) => void) {
  let carry = step / 2;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!, [x1, y1] = pts[i]!;
    const d = metres(x0, y0, x1, y1);
    if (!d) continue;
    const k = Math.cos((y0 * Math.PI) / 180);
    const bearing = Math.atan2((x1 - x0) * k, y1 - y0);
    for (let at = carry; at < d; at += step) fn(x0 + ((x1 - x0) * at) / d, y0 + ((y1 - y0) * at) / d, bearing);
    carry = ((carry - d) % step + step) % step;
  }
}

/**
 * Your rides near a place, for asking whether a trail has been ridden. A trail
 * counts where a ride passed within `near` metres going along it, not across.
 */
export class RideIndex {
  private cells = new Map<number, number[]>();
  /** x0, y0, x1, y1 per segment, in local metres. */
  private segs: number[] = [];
  private lat0: number;
  private k: number;
  private near: number;

  constructor(lines: Float64Array[], bounds: [number, number, number, number], near = 20) {
    this.near = near;
    this.lat0 = (bounds[1] + bounds[3]) / 2;
    this.k = Math.cos((this.lat0 * Math.PI) / 180) * M_PER_DEG;
    const [w, s, e, n] = bounds;
    for (const line of lines) {
      for (let i = 2; i + 1 < line.length; i += 2) {
        const ax = line[i - 2]!, ay = line[i - 1]!, bx = line[i]!, by = line[i + 1]!;
        if (Math.max(ax, bx) < w || Math.min(ax, bx) > e || Math.max(ay, by) < s || Math.min(ay, by) > n) continue;
        const id = this.segs.length / 4;
        const [x0, y0] = this.xy(ax, ay), [x1, y1] = this.xy(bx, by);
        this.segs.push(x0, y0, x1, y1);
        for (let cx = this.cell(Math.min(x0, x1)); cx <= this.cell(Math.max(x0, x1)); cx++) {
          for (let cy = this.cell(Math.min(y0, y1)); cy <= this.cell(Math.max(y0, y1)); cy++) {
            const key = cx * 1_000_003 + cy;
            const list = this.cells.get(key);
            if (list) list.push(id);
            else this.cells.set(key, [id]);
          }
        }
      }
    }
  }
  private xy = (lon: number, lat: number): [number, number] => [lon * this.k, (lat - this.lat0) * M_PER_DEG];
  private cell = (v: number) => Math.floor(v / this.near);

  /** Has a ride passed here, going roughly along `bearing` (either way)? */
  ridden = (lon: number, lat: number, bearing: number): boolean => {
    const [x, y] = this.xy(lon, lat);
    const cx = this.cell(x), cy = this.cell(y);
    const dx = Math.sin(bearing), dy = Math.cos(bearing);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (const id of this.cells.get(i * 1_000_003 + j) ?? []) {
          const x0 = this.segs[id * 4]!, y0 = this.segs[id * 4 + 1]!, x1 = this.segs[id * 4 + 2]!, y1 = this.segs[id * 4 + 3]!;
          const sx = x1 - x0, sy = y1 - y0;
          const l2 = sx * sx + sy * sy;
          if (!l2) continue;
          const t = Math.max(0, Math.min(1, ((x - x0) * sx + (y - y0) * sy) / l2));
          if (Math.hypot(x - x0 - t * sx, y - y0 - t * sy) > this.near) continue;
          // Along, not across: within about 45° either way.
          if (Math.abs((sx * dx + sy * dy) / Math.sqrt(l2)) >= 0.7) return true;
        }
      }
    }
    return false;
  };
}

/** The network for the map: each edge with its kind, and whether it is ridden or restricted. */
export function networkGeoJson(net: Network): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: net.edges.map((e, i) => {
      const coordinates: [number, number][] = [];
      for (let k = 0; k < e.coords.length; k += 2) coordinates.push([+e.coords[k]!.toFixed(6), +e.coords[k + 1]!.toFixed(6)]);
      return { type: 'Feature', id: i, properties: { kind: e.kind, ridden: e.ridden >= 0.5, restricted: e.restricted }, geometry: { type: 'LineString', coordinates } };
    }),
  };
}

/** How much of the network is ridden, in metres. */
export function coverage(net: Network): { total: number; ridden: number } {
  let total = 0, ridden = 0;
  for (const e of net.edges) {
    total += e.len;
    ridden += e.len * e.ridden;
  }
  return { total, ridden };
}
