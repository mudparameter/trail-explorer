// Ride files in an export .zip on disk. The reading is core/zipwalk.ts; here a
// file on disk is read in pieces, and zips inside are unpacked to a temporary
// file, read the same way, and deleted.
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import type { Found } from '../core/import.ts';
import { rideFilesIn as walk, type ZipHost, type ZipSource } from '../core/zipwalk.ts';

export { ZipError } from '../core/zipwalk.ts';

/** A file on disk as a ZipSource, and its path, so zips inside it can be streamed out. */
async function fileSource(path: string): Promise<ZipSource & { path: string; close(): Promise<void> }> {
  const fh = await open(path, 'r');
  const { size } = await fh.stat();
  return {
    path, size,
    async read(pos, len) {
      const b = Buffer.alloc(len);
      const { bytesRead } = await fh.read(b, 0, len, pos);
      return b.subarray(0, bytesRead);
    },
    close: () => fh.close(),
  };
}

/** Every ride file in the .zip at `path`, and in zips inside it. `tmpDir` holds inner zips while they are read. */
export async function* rideFilesIn(path: string, tmpDir: string): AsyncGenerator<Found> {
  const host: ZipHost = {
    async inner(src, e, start) {
      const from = (src as ZipSource & { path: string }).path;
      const tmp = join(tmpDir, `inner-${randomBytes(6).toString('hex')}.zip`);
      try {
        const s = createReadStream(from, { start, end: start + e.packed - 1 });
        await (e.method === 8 ? pipeline(s, createInflateRaw(), createWriteStream(tmp)) : pipeline(s, createWriteStream(tmp)));
        const f = await fileSource(tmp);
        return { src: f, done: async () => { await f.close(); await rm(tmp, { force: true }); } };
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },
  };
  const src = await fileSource(path);
  try {
    yield* walk(src, host);
  } finally {
    await src.close();
  }
}
