// Turning ride files into clean tracks. No Electron or DOM code here.

export interface Point {
  lon: number;
  lat: number;
  /** Seconds. NaN when unknown. */
  t: number;
}
/** A ride is one or more unbroken lines: flat arrays of lon, lat, lon, lat... */
export type Track = Float64Array[];

export const M_PER_DEG = 111_320;
const RAD = Math.PI / 180;

export function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * RAD);
  return Math.hypot(x, lat2 - lat1) * M_PER_DEG;
}

const MAX_SPEED = 35; // m/s. Faster than any bike: a GPS jump.
const GAP_M = 150; // Further apart than this is not joined up.
const STOP_M = 4; // Smaller moves are treated as standing still.

/** Drop bad points and standing-still wobble, and split where the GPS went missing. */
export function cleanTrack(points: Point[]): Track {
  const lines: number[][] = [];
  let line: number[] = [];
  let last: Point | null = null;
  let rejected = 0;
  const flush = () => {
    if (line.length >= 4) lines.push(line);
    line = [];
  };
  for (const p of points) {
    if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
    if (Math.abs(p.lat) > 85 || Math.abs(p.lon) > 180) continue;
    if (p.lon === 0 && p.lat === 0) continue;
    if (last) {
      const d = metres(last.lon, last.lat, p.lon, p.lat);
      if (d < STOP_M) continue;
      const dt = p.t - last.t;
      if (Number.isFinite(dt) && dt >= 0 && d > 30 && d / Math.max(dt, 1) > MAX_SPEED && rejected < 5) {
        rejected++; // Ignore it, unless the next few agree with it.
        continue;
      }
      if (d > GAP_M) flush();
    }
    rejected = 0;
    line.push(p.lon, p.lat);
    last = p;
  }
  flush();
  return lines.map((l) => Float64Array.from(l));
}

/** One flat array for storage, with NaN between lines. */
export function packTrack(track: Track): Float64Array {
  const n = track.reduce((s, l) => s + l.length + 2, 0);
  const out = new Float64Array(n);
  let i = 0;
  for (const l of track) {
    out.set(l, i);
    i += l.length;
    out[i++] = NaN;
    out[i++] = NaN;
  }
  return out;
}

export function unpackTrack(flat: Float64Array): Track {
  const out: Track = [];
  let start = 0;
  for (let i = 0; i < flat.length; i += 2) {
    if (Number.isNaN(flat[i])) {
      if (i > start) out.push(flat.slice(start, i));
      start = i + 2;
    }
  }
  return out;
}
