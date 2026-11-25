// Roads and trails inside an area, from OpenStreetMap data served by an Overpass API.
// No Node, Electron or DOM here: any host can fetch the query and pass the reply in.
import type { FeatureCollection } from 'geojson';
import type { Bounds } from './api.ts';
import { clipToShapes, projector, shapeBounds, type Shape } from './shapes.ts';

export type RoadKind = 'trail' | 'track' | 'cycleway' | 'road';
export const KINDS: { kind: RoadKind; label: string; color: string }[] = [
  { kind: 'trail', label: 'Trails and paths', color: '#c2410c' },
  { kind: 'track', label: 'Tracks', color: '#7c5a10' },
  { kind: 'cycleway', label: 'Cycleways', color: '#0369a1' },
  { kind: 'road', label: 'Roads', color: '#52525b' },
];

/** One road or trail: every OpenStreetMap way with the same name and kind, or all unnamed ways of a kind. */
export interface Road {
  /** Stable within one area, for selecting. */
  key: string;
  /** Null when OpenStreetMap has no name for it. */
  name: string | null;
  kind: RoadKind;
  /** Metres inside the area. */
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

/** Shorter than this inside an area is left out. */
const MIN_ROAD = 10;
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

export const kindOf = (tags: Record<string, string>): RoadKind | undefined => HIGHWAY[tags.highway ?? ''];

// --- tiles ----------------------------------------------------------------------
// Data is downloaded and kept by fixed map tiles, not by area, so areas that
// overlap share it: a new area only downloads the tiles nothing has asked for yet.

/** Zoom 15 tiles are about 1.2 km across at the equator, 0.9 km in Spain. */
export const TILE_ZOOM = 15;
const N = 2 ** TILE_ZOOM;
/** A tile as one number. */
export const tileKey = (x: number, y: number) => y * N + x;
export const tileXY = (k: number): [number, number] => [k % N, Math.floor(k / N)];
const lonX = (lon: number) => Math.min(N - 1, Math.max(0, Math.floor(((lon + 180) / 360) * N)));
const latY = (lat: number) => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.min(N - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N)));
};
const xLon = (x: number) => (x / N) * 360 - 180;
const yLat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI;
/** [west, south, east, north] of a tile. */
export function tileBounds(k: number): Bounds {
  const [x, y] = tileXY(k);
  return [xLon(x), yLat(y + 1), xLon(x + 1), yLat(y)];
}
/** Every tile in a box. Ways can be long, so this is capped. */
export function tilesInBounds([w, s, e, n]: Bounds, max = 40_000): number[] {
  const out: number[] = [];
  const [x0, x1, y0, y1] = [lonX(w), lonX(e), latY(n), latY(s)];
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > max) return out;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(tileKey(x, y));
  return out;
}
/** The tiles a shape touches, sorted. */
export function tilesFor(shape: Shape): number[] {
  const all = tilesInBounds(shapeBounds(shape));
  if (shape.kind === 'rect') return all;
  const pr = projector(shape.center);
  const [cx, cy] = shape.center;
  return all.filter((k) => {
    const [w, s, e, n] = tileBounds(k);
    // Nearest point of the tile to the centre.
    const [x, y] = pr.to([Math.max(w, Math.min(e, cx)), Math.max(s, Math.min(n, cy))]);
    return x * x + y * y <= shape.radius * shape.radius;
  }).sort((a, b) => a - b);
}

/** The Overpass QL for every road and trail in these tiles. Pavements, crossings and car park lanes are left out. */
export function overpassQuery(tiles: number[]): string {
  // Neighbouring tiles in a row become one box.
  const rows = new Map<number, number[]>();
  for (const k of tiles) {
    const [x, y] = tileXY(k);
    rows.set(y, [...(rows.get(y) ?? []), x]);
  }
  const boxes: Bounds[] = [];
  for (const [y, xs] of rows) {
    xs.sort((a, b) => a - b);
    let start = xs[0]!;
    xs.forEach((x, i) => {
      if (xs[i + 1] === x + 1) return;
      const [w, s] = tileBounds(tileKey(start, y));
      const [, , e, n] = tileBounds(tileKey(x, y));
      boxes.push([w, s, e, n]);
      start = xs[i + 1]!;
    });
  }
  const f = (v: number) => v.toFixed(7);
  const filter = `way["highway"~"^(${Object.keys(HIGHWAY).join('|')})$"]["area"!="yes"]["footway"!~"^(sidewalk|crossing)$"]["service"!~"^(parking_aisle|drive-through)$"]`;
  return `[out:json][timeout:120];
(
${boxes.map(([w, s, e, n]) => `${filter}(${f(s)},${f(w)},${f(n)},${f(e)});`).join('\n')}
);
out geom;`;
}

// --- ways -----------------------------------------------------------------------

/** One OpenStreetMap way, as kept in the shared store. Node ids join ways where they meet, for routes. */
export interface OsmWay {
  id: number;
  tags: Record<string, string>;
  nodes: number[];
  coords: [number, number][];
}

/** The ways in an Overpass reply. Throws when it is not one. */
export function parseOverpass(reply: unknown): OsmWay[] {
  const els = (reply as { elements?: unknown })?.elements;
  if (!Array.isArray(els)) throw new Error('The map data server sent something unexpected.');
  const out: OsmWay[] = [];
  for (const el of els) {
    if (el?.type !== 'way' || !Number.isSafeInteger(el.id) || !Array.isArray(el.geometry)) continue;
    const tags: Record<string, string> = el.tags && typeof el.tags === 'object' ? el.tags : {};
    if (!kindOf(tags)) continue;
    const g = el.geometry as { lon?: unknown; lat?: unknown }[];
    const nodes: unknown[] = Array.isArray(el.nodes) ? el.nodes : [];
    if (nodes.length !== g.length || g.length < 2) continue;
    if (!g.every((p) => typeof p?.lon === 'number' && typeof p?.lat === 'number') || !nodes.every(Number.isSafeInteger)) continue;
    out.push({ id: el.id, tags, nodes: nodes as number[], coords: g.map((p) => [p.lon as number, p.lat as number]) });
  }
  return out;
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

/** The roads and trails inside any of the shapes, as one area, from ways. Longest first within each kind. */
export function roadsIn(ways: OsmWay[], shapes: Shape[]): Road[] {
  const groups = new Map<string, Road & { surfaces: Map<string, number>; levels: Map<string, number> }>();
  for (const way of ways) {
    const t = way.tags;
    const kind = kindOf(t);
    if (!kind) continue;
    const clipped = clipToShapes(way.coords, shapes);
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
    // Slivers where a way just touches the edge are noise.
    .filter((r) => r.length >= MIN_ROAD)
    .map(({ surfaces, levels, ...r }) => ({ ...r, surface: top(surfaces)?.replace(/_/g, ' ') ?? null, difficulty: top(levels), length: Math.round(r.length) }))
    // Named first, then by length, so the unnamed group comes last in each kind.
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || Number(a.name === null) - Number(b.name === null) || b.length - a.length);
}

/** Reads an Overpass reply straight into roads inside a shape. */
export const readOverpass = (reply: unknown, shape: Shape): Road[] => roadsIn(parseOverpass(reply), [shape]);

/** Total length of each kind. */
export function kindTotals(roads: Road[]): Partial<Record<RoadKind, number>> {
  const out: Partial<Record<RoadKind, number>> = {};
  for (const r of roads) out[r.kind] = (out[r.kind] ?? 0) + r.length;
  return out;
}

/** Roads as map lines, for drawing. `prefix` keeps keys apart when several areas are drawn. */
export function roadsGeoJson(roads: Road[], prefix = ''): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: roads.map((r) => ({
      type: 'Feature',
      properties: { key: prefix + r.key, kind: r.kind, name: r.name ?? '' },
      geometry: { type: 'MultiLineString', coordinates: r.lines },
    })),
  };
}

/** "850 m" or "3.4 km". */
export function distance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}
