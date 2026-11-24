// Reads ride files from an export, such as Garmin's "Export your data" or
// Strava's bulk export. No Electron or DOM code here.
import { gunzipSync } from 'fflate';
import { readFit, type RideFile } from './fit.ts';
import type { Point } from './track.ts';

/** Ride files bigger than this are not rides. */
const MAX_FILE = 100 * 1024 * 1024;
const RIDE = /\.(fit|gpx|tcx)(\.gz)?$/i;

export const isRideFile = (name: string) => RIDE.test(name);

/** A ride found in an export, by its path inside it. */
export interface Found {
  name: string;
  data: Uint8Array;
}

/** Reads a .fit, .gpx or .tcx file, gzipped or not. */
export async function readRideFile(name: string, data: Uint8Array): Promise<RideFile> {
  let n = name.toLowerCase();
  if (n.endsWith('.gz')) {
    data = gunzipSync(data);
    n = n.slice(0, -3);
  }
  if (data.length > MAX_FILE) throw new Error('The file is too big to be a ride.');
  if (n.endsWith('.fit')) return readFit(data);
  const text = new TextDecoder().decode(data);
  if (n.endsWith('.gpx')) return readGpx(text);
  if (n.endsWith('.tcx')) return readTcx(text);
  throw new Error(`${name} is not a ride file.`);
}

const attr = (tag: string, a: string) => tag.match(new RegExp(`\\b${a}\\s*=\\s*["']([^"']*)["']`))?.[1];
const inner = (body: string, t: string) => body.match(new RegExp(`<(?:\\w+:)?${t}[^>]*>([^<]*)</(?:\\w+:)?${t}>`))?.[1]?.trim();
const seconds = (s: string | undefined) => (s ? Date.parse(s) / 1000 : NaN);

function finish(points: Point[], sport: string | null, startedAt: string | null): RideFile {
  const first = points.find((p) => Number.isFinite(p.t));
  const when = startedAt ? Date.parse(startedAt) : first ? first.t * 1000 : NaN;
  return { points, sport, subSport: null, startedAt: Number.isFinite(when) ? new Date(when).toISOString() : null };
}

export function readGpx(text: string): RideFile {
  const points: Point[] = [];
  for (const m of text.matchAll(/<(?:\w+:)?trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?trkpt>)/g)) {
    const lat = Number(attr(m[1]!, 'lat'));
    const lon = Number(attr(m[1]!, 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    points.push({ lon, lat, t: seconds(m[2] ? inner(m[2], 'time') : undefined) });
  }
  const sport = inner(text.match(/<(?:\w+:)?trk\b[\s\S]*?<\/(?:\w+:)?trk>/)?.[0] ?? '', 'type') ?? null;
  const meta = text.match(/<(?:\w+:)?metadata\b[\s\S]*?<\/(?:\w+:)?metadata>/)?.[0];
  return finish(points, sport, (meta && inner(meta, 'time')) || null);
}

export function readTcx(text: string): RideFile {
  const points: Point[] = [];
  for (const m of text.matchAll(/<(?:\w+:)?Trackpoint\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Trackpoint>/g)) {
    const lat = Number(inner(m[1]!, 'LatitudeDegrees'));
    const lon = Number(inner(m[1]!, 'LongitudeDegrees'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    points.push({ lon, lat, t: seconds(inner(m[1]!, 'Time')) });
  }
  const act = text.match(/<(?:\w+:)?Activity\b[^>]*>/)?.[0];
  return finish(points, (act && attr(act, 'Sport')?.toLowerCase()) || null, text.match(/<(?:\w+:)?Lap\b[^>]*StartTime\s*=\s*["']([^"']+)/)?.[1] ?? null);
}

/** Milliseconds since 1970 for a start time. Garmin's list gives UTC without a "Z". */
export function startMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.trim().replace(' ', 'T')}Z`;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** Rides starting this close together are the same ride. */
export const SAME_RIDE_MS = 2 * 60_000;

/** Indoor and virtual rides: no GPS, or GPS for somewhere you weren't. */
export const isIndoor = (r: Pick<RideFile, 'sport' | 'subSport'>) => /virtual|indoor|treadmill|trainer/i.test(`${r.sport ?? ''} ${r.subSport ?? ''}`);
