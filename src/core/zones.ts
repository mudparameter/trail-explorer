// Excluded zones: places left out of the heatmap, such as around home.
// They are GeoJSON, so any map tool can draw them. A circle is a Point with a
// "radius" in metres. Any Polygon or MultiPolygon works too.
import type { FeatureCollection } from 'geojson';
import { M_PER_DEG, metres, type Track } from './track.ts';

type Ring = [number, number][];
interface ZoneBase {
  /** File and position in it, like "zones/zones.geojson#2". */
  id: string;
  file: string;
  index: number;
  name: string;
  /** The app may change it: a circle in the app's own zones file. */
  editable: boolean;
}
export type Zone =
  | (ZoneBase & { kind: 'circle'; center: [number, number]; radius: number })
  | (ZoneBase & { kind: 'polygon'; polygons: Ring[][] });

export const MIN_RADIUS = 10;
export const MAX_RADIUS = 100_000;
const RAD = Math.PI / 180;

function features(v: any): any[] | null {
  if (v?.type === 'FeatureCollection' && Array.isArray(v.features)) return v.features;
  if (v?.type === 'Feature') return [v];
  if (typeof v?.type === 'string' && 'coordinates' in v) return [{ type: 'Feature', properties: {}, geometry: v }];
  return null;
}

const isPos = (p: unknown): p is [number, number] =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0] as number) <= 180 && Math.abs(p[1] as number) <= 90;
const isRing = (r: unknown): r is Ring => Array.isArray(r) && r.length >= 4 && r.length <= 100_000 && r.every(isPos);
const isPolygon = (p: unknown): p is Ring[] => Array.isArray(p) && p.length >= 1 && p.every(isRing);

/** Reads one zones file. Problems are messages about features that were left out. */
export function parseZones(file: string, text: string, editable: boolean): { zones: Zone[]; problems: string[] } {
  const zones: Zone[] = [];
  const problems: string[] = [];
  let fs: any[] | null;
  try {
    fs = features(JSON.parse(text));
  } catch (e) {
    return { zones, problems: [`Not valid JSON: ${e instanceof Error ? e.message : e}`] };
  }
  if (!fs) return { zones, problems: ['Should be GeoJSON: a FeatureCollection, a Feature or a geometry.'] };
  fs.forEach((f, index) => {
    const at = `Zone ${index + 1}`;
    const g = f?.geometry;
    const props = f?.properties && typeof f.properties === 'object' ? f.properties : {};
    const name = typeof props.name === 'string' && props.name.trim() ? props.name.trim().slice(0, 100) : at;
    const base = { id: `${file}#${index}`, file, index, name };
    if (g?.type === 'Point') {
      const r = props.radius;
      if (!isPos(g.coordinates)) problems.push(`${at}: the point's coordinates should be [longitude, latitude]. It is left out.`);
      else if (!(typeof r === 'number' && r >= MIN_RADIUS && r <= MAX_RADIUS)) {
        problems.push(`${at}: a point needs "radius" in its properties, in metres from ${MIN_RADIUS} to ${MAX_RADIUS}. It is left out.`);
      } else zones.push({ ...base, editable, kind: 'circle', center: [g.coordinates[0], g.coordinates[1]], radius: r });
    } else if (g?.type === 'Polygon' && isPolygon(g.coordinates)) {
      zones.push({ ...base, editable: false, kind: 'polygon', polygons: [g.coordinates] });
    } else if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates.length && g.coordinates.every(isPolygon)) {
      zones.push({ ...base, editable: false, kind: 'polygon', polygons: g.coordinates });
    } else if (g?.type === 'Polygon' || g?.type === 'MultiPolygon') {
      problems.push(`${at}: the shape's coordinates are not a closed ring of [longitude, latitude] points. It is left out.`);
    } else {
      problems.push(`${at}: only areas can be zones (a Point with a radius, a Polygon or a MultiPolygon), not ${g?.type ?? 'nothing'}. It is left out.`);
    }
  });
  return { zones, problems };
}

// --- clipping -------------------------------------------------------------------

interface Prepared {
  w: number; s: number; e: number; n: number;
  inside(lon: number, lat: number): boolean;
}

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function prepare(z: Zone): Prepared {
  if (z.kind === 'circle') {
    const [lon, lat] = z.center;
    const dLat = z.radius / M_PER_DEG;
    const dLon = dLat / Math.max(Math.cos(lat * RAD), 0.01);
    return { w: lon - dLon, e: lon + dLon, s: lat - dLat, n: lat + dLat, inside: (x, y) => metres(lon, lat, x, y) <= z.radius };
  }
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of z.polygons) for (const [x, y] of p[0]!) {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
  }
  // Holes come after the outer ring. Inside means inside the outer ring and no hole.
  return { w, s, e, n, inside: (x, y) => z.polygons.some((p) => inRing(x, y, p[0]!) && !p.slice(1).some((h) => inRing(x, y, h))) };
}

/** Removes every part of a ride inside a zone, splitting lines where they pass through one. */
export function clipTrack(track: Track, zones: Zone[]): Track {
  if (!zones.length) return track;
  const ps = zones.map(prepare);
  const out: Track = [];
  for (const line of track) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (let i = 0; i < line.length; i += 2) {
      w = Math.min(w, line[i]!); e = Math.max(e, line[i]!); s = Math.min(s, line[i + 1]!); n = Math.max(n, line[i + 1]!);
    }
    const near = ps.filter((p) => p.w <= e && p.e >= w && p.s <= n && p.n >= s);
    if (!near.length) {
      out.push(line);
      continue;
    }
    let start = -1;
    const flush = (end: number) => {
      if (start >= 0 && end - start >= 4) out.push(line.slice(start, end));
      start = -1;
    };
    for (let i = 0; i < line.length; i += 2) {
      const x = line[i]!, y = line[i + 1]!;
      if (near.some((p) => x >= p.w && x <= p.e && y >= p.s && y <= p.n && p.inside(x, y))) flush(i);
      else if (start < 0) start = i;
    }
    flush(line.length);
  }
  return out;
}

// --- drawing --------------------------------------------------------------------

/** A circle as a polygon ring, for drawing. */
export function circleRing(center: [number, number], radius: number, steps = 72): Ring {
  const [lon, lat] = center;
  const dLat = radius / M_PER_DEG;
  const dLon = dLat / Math.max(Math.cos(lat * RAD), 0.01);
  const ring: Ring = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  ring.push(ring[0]!);
  return ring;
}

/** All zones as polygons, for showing them on the map. */
export function zonesGeoJson(zones: Zone[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: zones.map((z) => ({
      type: 'Feature',
      id: z.index,
      properties: { id: z.id, name: z.name },
      geometry: z.kind === 'circle'
        ? { type: 'Polygon', coordinates: [circleRing(z.center, z.radius)] }
        : { type: 'MultiPolygon', coordinates: z.polygons },
    })),
  };
}

// --- editing the app's zones file -------------------------------------------------

export interface CircleEdit {
  name?: string;
  center?: [number, number];
  radius?: number;
}

function load(text: string | undefined): { type: 'FeatureCollection'; features: any[]; [k: string]: unknown } {
  if (!text) return { type: 'FeatureCollection', features: [] };
  const v = JSON.parse(text);
  if (v?.type !== 'FeatureCollection' || !Array.isArray(v.features)) throw new Error('The zones file is not a FeatureCollection, so the app will not change it. Fix or move it first.');
  return v;
}
function checkCircle(c: CircleEdit) {
  if (c.center && !isPos(c.center)) throw new Error('A zone needs a place on the map.');
  if (c.radius !== undefined && !(Number.isFinite(c.radius) && c.radius >= MIN_RADIUS && c.radius <= MAX_RADIUS)) {
    throw new Error(`A zone's radius should be ${MIN_RADIUS} to ${MAX_RADIUS} metres.`);
  }
  if (c.name !== undefined && (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 100)) throw new Error('A zone needs a name of up to 100 characters.');
}
const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** The zones file with a circle added. */
export function addCircle(text: string | undefined, c: Required<CircleEdit>): string {
  checkCircle(c);
  const fc = load(text);
  fc.features.push({
    type: 'Feature',
    properties: { name: c.name.trim(), radius: Math.round(c.radius) },
    geometry: { type: 'Point', coordinates: [round(c.center[0]), round(c.center[1])] },
  });
  return zonesText(fc);
}

/** The zones file with circle number `index` changed. */
export function editCircle(text: string | undefined, index: number, c: CircleEdit): string {
  checkCircle(c);
  const fc = load(text);
  const f = fc.features[index];
  if (f?.geometry?.type !== 'Point') throw new Error('That zone has changed in the file. Try again.');
  f.properties = { ...f.properties };
  if (c.name !== undefined) f.properties.name = c.name.trim();
  if (c.radius !== undefined) f.properties.radius = Math.round(c.radius);
  if (c.center) f.geometry = { ...f.geometry, coordinates: [round(c.center[0]), round(c.center[1])] };
  return zonesText(fc);
}

/** The zones file without feature number `index`. */
export function removeZone(text: string | undefined, index: number): string {
  const fc = load(text);
  if (!fc.features[index]) throw new Error('That zone has changed in the file. Try again.');
  fc.features.splice(index, 1);
  return zonesText(fc);
}

/** One feature per line, so the file is easy to read and compare. */
function zonesText(fc: { features: any[]; [k: string]: unknown }): string {
  const { features: fs, ...rest } = fc;
  const head = JSON.stringify(rest).slice(1, -1);
  return `{${head},\n "features": [\n${fs.map((f) => '  ' + JSON.stringify(f)).join(',\n')}\n ]}\n`;
}
