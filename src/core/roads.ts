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
  /** Stable within one area, for selecting. */
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
/** Shorter than this inside a circle is left out. */
const MIN_ROAD = 10;
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

export const kindOf = (tags: Record<string, string>): RoadKind | undefined => HIGHWAY[tags.highway ?? ''];

// --- tiles ----------------------------------------------------------------------
// Data is downloaded and kept by fixed map tiles, not by circle, so circles that
// overlap share it: a new circle only downloads the tiles nothing has asked for yet.

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
export function circleBounds(center: [number, number], radius: number): Bounds {
  const dLat = radius / M_PER_DEG;
  const dLon = dLat / Math.max(Math.cos((center[1] * Math.PI) / 180), 0.01);
  return [center[0] - dLon, center[1] - dLat, center[0] + dLon, center[1] + dLat];
}
/** The tiles a circle touches, sorted. */
export function tilesFor(center: [number, number], radius: number): number[] {
  const pr = projector(center);
  return tilesInBounds(circleBounds(center, radius)).filter((k) => {
    const [w, s, e, n] = tileBounds(k);
    // Nearest point of the tile to the centre.
    const [x, y] = pr.to([Math.max(w, Math.min(e, center[0])), Math.max(s, Math.min(n, center[1]))]);
    return x * x + y * y <= radius * radius;
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

/**
 * The parts of a line inside any of the circles, with their length in metres.
 * Overlaps count once, so circles joined into one area never count a road twice.
 */
export function clipToCircles(line: [number, number][], circles: { center: [number, number]; radius: number }[]): { lines: [number, number][][]; length: number } {
  if (circles.length === 1) return clipToCircle(line, circles[0]!.center, circles[0]!.radius);
  const pr = projector(circles[0]!.center);
  const ps = line.map(pr.to);
  const cs = circles.map((c) => ({ at: pr.to(c.center), r: c.radius }));
  const inside = (p: [number, number]) => cs.some((c) => (p[0] - c.at[0]) ** 2 + (p[1] - c.at[1]) ** 2 <= c.r * c.r);
  const out: [number, number][][] = [];
  let length = 0;
  let cur: [number, number][] | null = null;
  let last: [number, number] | null = null;
  const add = (p: [number, number]) => {
    if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) return;
    if (last) length += Math.hypot(p[0] - last[0], p[1] - last[1]);
    cur!.push(pr.from(p[0], p[1]));
    last = p;
  };
  const end = () => {
    if (cur && cur.length >= 2) out.push(cur);
    cur = null;
    last = null;
  };
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1]!, b = ps[i]!;
    const at = (t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    // Cut the segment wherever it crosses any circle, and keep the pieces whose middle is inside one.
    const ts = [0, ...cs.flatMap((c) => crossings([a[0] - c.at[0], a[1] - c.at[1]], [b[0] - c.at[0], b[1] - c.at[1]], c.r)), 1].sort((x, y) => x - y);
    for (let j = 1; j < ts.length; j++) {
      const t0 = ts[j - 1]!, t1 = ts[j]!;
      if (t1 - t0 < 1e-12) continue;
      if (inside(at((t0 + t1) / 2))) {
        if (!cur) cur = [];
        add(at(t0));
        add(at(t1));
      } else end();
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

/** The roads and trails inside a circle, from ways, longest first within each kind. */
export function roadsIn(ways: OsmWay[], center: [number, number], radius: number): Road[] {
  return roadsInCircles(ways, [{ center, radius }]);
}

/** The roads and trails inside any of the circles, as one area. */
export function roadsInCircles(ways: OsmWay[], circles: { center: [number, number]; radius: number }[]): Road[] {
  const groups = new Map<string, Road & { surfaces: Map<string, number>; levels: Map<string, number> }>();
  for (const way of ways) {
    const t = way.tags;
    const kind = kindOf(t);
    if (!kind) continue;
    const clipped = clipToCircles(way.coords, circles);
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

/** Reads an Overpass reply straight into roads inside a circle. */
export const readOverpass = (reply: unknown, center: [number, number], radius: number): Road[] => roadsIn(parseOverpass(reply), center, radius);

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
