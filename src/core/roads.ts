// Roads and trails inside a circle, from OpenStreetMap data served by an Overpass API.
// No Node, Electron or DOM here: any host can fetch the query and pass the reply in.
import type { FeatureCollection } from 'geojson';
import type { Bounds } from './api.ts';
import { M_PER_DEG } from './track.ts';

export type RoadKind = 'trail' | 'track' | 'cycleway' | 'road';
export const KINDS: { kind: RoadKind; label: string; color: string }[] = [
  { kind: 'trail', label: 'Trails and paths', color: '#c2410c' },
  { kind: 'track', label: 'Tracks', color: '#7c5a10' },
  { kind: 'cycleway', label: 'Cycleways', color: '#0369a1' },
  { kind: 'road', label: 'Roads', color: '#52525b' },
];

/** One road or trail: every OpenStreetMap way with the same name and kind, or all unnamed ways of a kind. */
export interface Road {
  /** Stable within one search, for selecting. */
  key: string;
  /** Null when OpenStreetMap has no name for it. */
  name: string | null;
  kind: RoadKind;
  /** Metres inside the circle. */
  length: number;
  /** Most common values, by length, such as "gravel" or "MTB S2". */
  surface: string | null;
  difficulty: string | null;
  /** Some of it is marked private or no entry. */
  private: boolean;
  /** Some of it is marked no bicycles, or bikes must be walked. */
  noBikes: boolean;
  lines: [number, number][][];
  bounds: Bounds;
}

export const MIN_AREA = 50;
export const MAX_AREA = 10_000;
/** Public Overpass servers are often busy, so the config may list several to try in order. */
export const DEFAULT_OVERPASS = ['https://overpass-api.de/api/interpreter'];
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

const HIGHWAY: Record<string, RoadKind> = {
  path: 'trail', footway: 'trail', bridleway: 'trail', steps: 'trail', pedestrian: 'trail',
  track: 'track',
  cycleway: 'cycleway',
  motorway: 'road', trunk: 'road', primary: 'road', secondary: 'road', tertiary: 'road',
  motorway_link: 'road', trunk_link: 'road', primary_link: 'road', secondary_link: 'road', tertiary_link: 'road',
  unclassified: 'road', residential: 'road', living_street: 'road', service: 'road', road: 'road',
};

/** The Overpass QL for every road and trail within `radius` metres. Pavements, crossings and car park lanes are left out. */
export function overpassQuery(center: [number, number], radius: number): string {
  const [lon, lat] = center;
  const kinds = Object.keys(HIGHWAY).join('|');
  const at = `(around:${Math.round(radius)},${lat.toFixed(6)},${lon.toFixed(6)})`;
  return `[out:json][timeout:90];
way["highway"~"^(${kinds})$"]["area"!="yes"]["footway"!~"^(sidewalk|crossing)$"]["service"!~"^(parking_aisle|drive-through)$"]${at};
out tags geom;`;
}

/** Local flat coordinates in metres around the circle's centre. Accurate enough for 10 km. */
function projector(center: [number, number]) {
  const k = Math.cos((center[1] * Math.PI) / 180) * M_PER_DEG;
  return {
    to: (p: [number, number]): [number, number] => [(p[0] - center[0]) * k, (p[1] - center[1]) * M_PER_DEG],
    from: (x: number, y: number): [number, number] => [center[0] + x / k, center[1] + y / M_PER_DEG],
  };
}

/** Where the segment a→b crosses the circle, as fractions along it, sorted. */
function crossings(a: [number, number], b: [number, number], r: number): number[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const A = dx * dx + dy * dy;
  if (A === 0) return [];
  const B = 2 * (a[0] * dx + a[1] * dy);
  const C = a[0] * a[0] + a[1] * a[1] - r * r;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].filter((t) => t > 0 && t < 1);
}

/** The parts of a line inside the circle, cut exactly at its edge, with their length in metres. */
export function clipToCircle(line: [number, number][], center: [number, number], radius: number): { lines: [number, number][][]; length: number } {
  const pr = projector(center);
  const ps = line.map(pr.to);
  const inside = (p: [number, number]) => p[0] * p[0] + p[1] * p[1] <= radius * radius;
  const out: [number, number][][] = [];
  let length = 0;
  let cur: [number, number][] | null = null;
  let last: [number, number] | null = null;
  const add = (p: [number, number]) => {
    if (last) length += Math.hypot(p[0] - last[0], p[1] - last[1]);
    cur!.push(pr.from(p[0], p[1]));
    last = p;
  };
  const end = () => {
    if (cur && cur.length >= 2) out.push(cur);
    cur = null;
    last = null;
  };
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (i === 0) {
      if (inside(p)) {
        cur = [];
        add(p);
      }
      continue;
    }
    const a = ps[i - 1]!;
    const at = (t: number): [number, number] => [a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t];
    const ts = crossings(a, p, radius);
    // Each crossing switches between inside and outside.
    for (const t of ts) {
      if (cur) {
        add(at(t));
        end();
      } else {
        cur = [];
        add(at(t));
      }
    }
    if (cur) add(p);
    else if (inside(p)) {
      // Started exactly on the edge.
      cur = [];
      add(p);
    }
  }
  end();
  return { lines: out, length };
}

function difficulty(t: Record<string, string>): string | null {
  const mtb = t['mtb:scale'];
  if (mtb && /^[0-6][+-]?$/.test(mtb)) return `MTB S${mtb}`;
  const tt = t.tracktype;
  if (tt && /^grade[1-5]$/.test(tt)) return `grade ${tt.slice(5)}`;
  const sac = t.sac_scale;
  if (sac) return sac.replace(/_/g, ' ');
  return null;
}
const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

/** Reads an Overpass reply into roads inside the circle, longest first within each kind. */
export function readOverpass(reply: unknown, center: [number, number], radius: number): Road[] {
  const els = (reply as { elements?: unknown })?.elements;
  if (!Array.isArray(els)) throw new Error('The map data server sent something unexpected.');
  const groups = new Map<string, Road & { surfaces: Map<string, number>; levels: Map<string, number> }>();
  for (const el of els) {
    if (el?.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const t: Record<string, string> = el.tags && typeof el.tags === 'object' ? el.tags : {};
    const kind = HIGHWAY[t.highway ?? ''];
    if (!kind) continue;
    const line = (el.geometry as { lon: unknown; lat: unknown }[])
      .filter((p) => typeof p?.lon === 'number' && typeof p?.lat === 'number')
      .map((p) => [p.lon, p.lat] as [number, number]);
    if (line.length < 2) continue;
    const clipped = clipToCircle(line, center, radius);
    if (!clipped.lines.length || clipped.length < 1) continue;
    const name = (t.name ?? t.ref ?? '').trim() || null;
    const key = `${kind}:${name?.toLowerCase() ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, name, kind, length: 0, surface: null, difficulty: null, private: false, noBikes: false, lines: [], bounds: [180, 90, -180, -90], surfaces: new Map(), levels: new Map() };
      groups.set(key, g);
    }
    g.length += clipped.length;
    g.lines.push(...clipped.lines);
    if (t.surface) g.surfaces.set(t.surface, (g.surfaces.get(t.surface) ?? 0) + clipped.length);
    const d = difficulty(t);
    if (d) g.levels.set(d, (g.levels.get(d) ?? 0) + clipped.length);
    if (['private', 'no'].includes(t.access ?? '')) g.private = true;
    if (['no', 'dismount', 'private'].includes(t.bicycle ?? '')) g.noBikes = true;
    for (const l of clipped.lines) for (const [x, y] of l) {
      g.bounds = [Math.min(g.bounds[0], x), Math.min(g.bounds[1], y), Math.max(g.bounds[2], x), Math.max(g.bounds[3], y)];
    }
  }
  const order = KINDS.map((k) => k.kind);
  return [...groups.values()]
    .map(({ surfaces, levels, ...r }) => ({ ...r, surface: top(surfaces)?.replace(/_/g, ' ') ?? null, difficulty: top(levels), length: Math.round(r.length) }))
    // Named first, then by length, so the unnamed group comes last in each kind.
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || Number(a.name === null) - Number(b.name === null) || b.length - a.length);
}

/** Roads as map lines, for drawing. */
export function roadsGeoJson(roads: Road[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: roads.map((r) => ({
      type: 'Feature',
      properties: { key: r.key, kind: r.kind, name: r.name ?? '' },
      geometry: { type: 'MultiLineString', coordinates: r.lines },
    })),
  };
}

/** "850 m" or "3.4 km". */
export function distance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}
