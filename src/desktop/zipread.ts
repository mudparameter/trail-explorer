// Reads a .zip on disk through its central directory, the list at the end of
// the file, like unzip does. Streaming a .zip from the start can't tell where
// an entry ends when its sizes come after the data, as in Garmin's exports.
// Only one entry is in memory at a time; zips inside are unpacked to a
// temporary file, read the same way, and deleted.
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createInflateRaw, inflateRaw } from 'node:zlib';
import { isRideFile, type Found } from '../core/import.ts';

const inflate = promisify(inflateRaw);
/** Ride files bigger than this are not rides. */
const MAX_FILE = 100 * 1024 * 1024;
/** How deep zips inside zips are opened. */
const MAX_DEPTH = 3;

interface Entry {
  name: string;
  method: number;
  flags: number;
  packed: number;
  size: number;
  offset: number;
}

export class ZipError extends Error {}

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, pos);
  return b.subarray(0, bytesRead);
}

/** The entries listed in a .zip's central directory. */
async function entries(fh: FileHandle): Promise<Entry[]> {
  const { size } = await fh.stat();
  const tailLen = Math.min(size, 65_557);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('That is not a .zip file, or it is incomplete.');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  // Zip64, for big archives.
  const loc = eocd - 20;
  if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
    const rec = await readAt(fh, Number(tail.readBigUInt64LE(loc + 8)), 56);
    if (rec.readUInt32LE(0) === 0x06064b50) {
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
  }
  const cd = await readAt(fh, cdOffset, cdSize);
  const out: Entry[] = [];
  for (let p = 0, n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The .zip file is damaged.');
    const flags = cd.readUInt16LE(p + 8);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    let packed = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    let offset = cd.readUInt32LE(p + 42);
    // Zip64 sizes and offset, in that order, for whichever are 0xffffffff.
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end; ) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (packed === 0xffffffff) { packed = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
      }
      x += 4 + len;
    }
    out.push({ name, method: cd.readUInt16LE(p + 10), flags, packed, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Where an entry's data starts: after its local header, whose lengths can differ from the directory's. */
async function dataStart(fh: FileHandle, e: Entry): Promise<number> {
  const h = await readAt(fh, e.offset, 30);
  if (h.length < 30 || h.readUInt32LE(0) !== 0x04034b50) throw new ZipError(`${e.name} is damaged.`);
  return e.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

const readable = (e: Entry) => !(e.flags & 1) && (e.method === 0 || e.method === 8);

/**
 * Every ride file in the .zip at `path`, and in zips inside it. `tmpDir` holds
 * inner zips while they are read.
 */
export async function* rideFilesIn(path: string, tmpDir: string, depth = 0, prefix = ''): AsyncGenerator<Found> {
  const fh = await open(path, 'r');
  try {
    for (const e of await entries(fh)) {
      if (e.name.endsWith('/') || !readable(e)) continue;
      const name = prefix + e.name;
      if (/\.zip$/i.test(e.name) && depth < MAX_DEPTH) {
        const tmp = join(tmpDir, `inner-${randomBytes(6).toString('hex')}.zip`);
        try {
          const start = await dataStart(fh, e);
          const src = createReadStream(path, { start, end: start + e.packed - 1 });
          await (e.method === 8 ? pipeline(src, createInflateRaw(), createWriteStream(tmp)) : pipeline(src, createWriteStream(tmp)));
          yield* rideFilesIn(tmp, tmpDir, depth + 1, `${name}/`);
        } finally {
          await rm(tmp, { force: true });
        }
      } else if (isRideFile(e.name) && e.size <= MAX_FILE && e.packed <= MAX_FILE) {
        const raw = await readAt(fh, await dataStart(fh, e), e.packed);
        let data: Uint8Array;
        try {
          data = e.method === 8 ? await inflate(raw, { maxOutputLength: MAX_FILE }) : raw;
        } catch {
          yield { name, data: new Uint8Array(0) }; // counted as unreadable
          continue;
        }
        yield { name, data };
      }
    }
  } finally {
    await fh.close();
  }
}
