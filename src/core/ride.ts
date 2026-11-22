import { firstFile, readFit } from './fit.ts';
import { cleanTrack, packTrack } from './track.ts';

export type ReadRide = { status: 'done' | 'no-gps' | 'unread'; track: Float64Array | null };

/** Reads one Garmin download. Throws if the file is broken. */
export async function readRide(zip: Uint8Array): Promise<ReadRide> {
  const { name, data } = firstFile(zip);
  if (!/\.fit$/i.test(name)) return { status: 'unread', track: null };
  const track = cleanTrack((await readFit(data)).points);
  return track.length ? { status: 'done', track: packTrack(track) } : { status: 'no-gps', track: null };
}
