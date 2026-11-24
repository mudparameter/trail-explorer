import { firstFile, readFit } from './fit.ts';
import { isIndoor, readRideFile } from './import.ts';
import { cleanTrack, packTrack } from './track.ts';

export type ReadRide = { status: 'done' | 'no-gps' | 'unread'; track: Float64Array | null };

/** Reads one Garmin download. Throws if the file is broken. */
export async function readRide(zip: Uint8Array): Promise<ReadRide> {
  const { name, data } = firstFile(zip);
  if (!/\.fit$/i.test(name)) return { status: 'unread', track: null };
  const track = cleanTrack((await readFit(data)).points);
  return track.length ? { status: 'done', track: packTrack(track) } : { status: 'no-gps', track: null };
}

export type ReadFile = ReadRide & { startedAt: string | null; sport: string | null; indoor: boolean };

/** Reads one ride file from an export. Throws if the file is broken. */
export async function readFile(name: string, data: Uint8Array): Promise<ReadFile> {
  const r = await readRideFile(name, data);
  const track = cleanTrack(r.points);
  const base = { startedAt: r.startedAt, sport: r.sport, indoor: isIndoor(r) };
  return track.length ? { ...base, status: 'done', track: packTrack(track) } : { ...base, status: 'no-gps', track: null };
}
