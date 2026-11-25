// Ride files in an export .zip the visitor picks. The reading is
// core/zipwalk.ts; here the File is read in pieces, never all at once, and a
// zip inside it is unpacked into a Blob, which the browser may keep on disk.
// Exports of several GB work.
import { Inflate } from 'fflate';
import type { Found } from '../core/import.ts';
import { rideFilesIn as walk, type ZipEntry, type ZipHost, type ZipSource } from '../core/zipwalk.ts';

/** Read this much at a time when unpacking a zip inside the export. */
const CHUNK = 8 * 1024 * 1024;

const blobSource = (b: Blob): ZipSource & { blob: Blob } => ({
  blob: b,
  size: b.size,
  read: async (pos, len) => new Uint8Array(await b.slice(pos, pos + len).arrayBuffer()),
});

async function unpack(src: ZipSource & { blob: Blob }, e: ZipEntry, start: number): Promise<Blob> {
  // Stored: it is already a zip, at that place in the file.
  if (e.method === 0) return src.blob.slice(start, start + e.packed);
  const parts: Uint8Array[] = [];
  const inflate = new Inflate((chunk) => parts.push(chunk));
  for (let at = 0; at < e.packed; at += CHUNK) {
    const len = Math.min(CHUNK, e.packed - at);
    inflate.push(await src.read(start + at, len), at + len >= e.packed);
  }
  return new Blob(parts as Uint8Array<ArrayBuffer>[]);
}

/** Every ride file in the .zip, and in zips inside it. */
export function rideFilesIn(file: Blob): AsyncGenerator<Found> {
  const host: ZipHost = {
    async inner(src, e, start) {
      return { src: blobSource(await unpack(src as ZipSource & { blob: Blob }, e, start)), done: async () => {} };
    },
  };
  return walk(blobSource(file), host);
}
