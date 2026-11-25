import FitParser from 'fit-file-parser';
import { unzipSync } from 'fflate';
import type { Point } from './track.ts';

const MAX_UNZIPPED = 250 * 1024 * 1024;

export interface RideFile {
  points: Point[];
  sport: string | null;
  subSport: string | null;
  /** ISO time, when the file says. */
  startedAt: string | null;
}

/** The first file in a Garmin download .zip. */
export function firstFile(zip: Uint8Array): { name: string; data: Uint8Array } {
  let total = 0;
  const files = unzipSync(zip, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new Error('The unzipped file is too large.');
      return true;
    },
  });
  const entry = Object.entries(files).find(([n]) => /\.fit$/i.test(n)) ?? Object.entries(files)[0];
  if (!entry) throw new Error('The download was empty.');
  return { name: entry[0], data: entry[1] };
}

export async function readFit(data: Uint8Array): Promise<RideFile> {
  // An ArrayBuffer of just these bytes, not Node's Buffer, so this also runs in a browser.
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const fit: any = await new FitParser({ force: true, mode: 'list' }).parseAsync(bytes);
  const points: Point[] = [];
  for (const r of fit.records ?? []) {
    if (!Number.isFinite(r.position_lat) || !Number.isFinite(r.position_long)) continue;
    points.push({ lon: r.position_long, lat: r.position_lat, t: new Date(r.timestamp).getTime() / 1000 });
  }
  const s = fit.sessions?.[0] ?? fit.sports?.[0];
  const start = s?.start_time ?? fit.records?.[0]?.timestamp;
  const when = start ? new Date(start) : null;
  return {
    points,
    sport: s?.sport != null ? String(s.sport) : null,
    subSport: s?.sub_sport != null ? String(s.sub_sport) : null,
    startedAt: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
  };
}
