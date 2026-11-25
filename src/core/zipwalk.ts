// Finds ride files in an export .zip, and in zips inside it, by reading the
// .zip's central directory, the list at its end, like unzip does. Streaming a
// .zip from the start can't tell where an entry ends when its sizes come after
// the data, as in Garmin's exports. Only one ride file is in memory at a time,
// so exports of several GB work. No Node, Electron or DOM here: the host says how
// to read the file and where to put zips inside it while they are read.
import { inflateSync } from 'fflate';
import { isRideFile, type Found } from './import.ts';

/** A file that can be read at any position: a file on disk, or a File or Blob in a browser. */
export interface ZipSource {
  size: number;
  read(pos: number, len: number): Promise<Uint8Array>;
}

/** An entry in a .zip: where its data is, and how it is packed. */
export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  flags: number;
  packed: number;
  size: number;
  offset: number;
}

export interface ZipHost {
  /**
   * A zip inside the .zip, unpacked somewhere it can be read, such as a temporary
   * file or a Blob. `start` is where its data begins in `src`. `done` cleans up after.
   */
  inner(src: ZipSource, e: ZipEntry, start: number): Promise<{ src: ZipSource; done(): Promise<void> }>;
}

export class ZipError extends Error {}

/** Ride files bigger than this are not rides. */
const MAX_FILE = 100 * 1024 * 1024;
/** How deep zips inside zips are opened. */
const MAX_DEPTH = 3;

const u16 = (b: Uint8Array, p: number) => b[p]! | (b[p + 1]! << 8);
const u32 = (b: Uint8Array, p: number) => (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
const u64 = (b: Uint8Array, p: number) => u32(b, p) + u32(b, p + 4) * 2 ** 32;
const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

/** The entries listed in a .zip's central directory. */
export async function zipEntries(src: ZipSource): Promise<ZipEntry[]> {
  const tailLen = Math.min(src.size, 65_557);
  const tail = await src.read(src.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('That is not a .zip file, or it is incomplete.');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  // Zip64, for big archives.
  const loc = eocd - 20;
  if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
    const rec = await src.read(u64(tail, loc + 8), 56);
    if (u32(rec, 0) === 0x06064b50) {
      count = u64(rec, 32);
      cdSize = u64(rec, 40);
      cdOffset = u64(rec, 48);
    }
  }
  const cd = await src.read(cdOffset, cdSize);
  const out: ZipEntry[] = [];
  const utf8 = new TextDecoder();
  for (let p = 0, n = 0; n < count && p + 46 <= cd.length; n++) {
    if (u32(cd, p) !== 0x02014b50) throw new ZipError('The .zip file is damaged.');
    const flags = u16(cd, p + 8);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const raw = cd.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 ? utf8.decode(raw) : latin1(raw);
    let packed = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    let offset = u32(cd, p + 42);
    // Zip64 sizes and offset, in that order, for whichever are 0xffffffff.
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end; ) {
      const id = u16(cd, x);
      const len = u16(cd, x + 2);
      if (id === 1) {
        let q = x + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (packed === 0xffffffff) { packed = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      x += 4 + len;
    }
    out.push({ name, method: u16(cd, p + 10), flags, packed, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Where an entry's data starts: after its local header, whose lengths can differ from the directory's. */
export async function dataStart(src: ZipSource, e: ZipEntry): Promise<number> {
  const h = await src.read(e.offset, 30);
  if (h.length < 30 || u32(h, 0) !== 0x04034b50) throw new ZipError(`${e.name} is damaged.`);
  return e.offset + 30 + u16(h, 26) + u16(h, 28);
}

const readable = (e: ZipEntry) => !(e.flags & 1) && (e.method === 0 || e.method === 8);

/** Every ride file in the .zip, and in zips inside it. */
export async function* rideFilesIn(src: ZipSource, host: ZipHost, depth = 0, prefix = ''): AsyncGenerator<Found> {
  for (const e of await zipEntries(src)) {
    if (e.name.endsWith('/') || !readable(e)) continue;
    const name = prefix + e.name;
    if (/\.zip$/i.test(e.name) && depth < MAX_DEPTH) {
      const inner = await host.inner(src, e, await dataStart(src, e));
      try {
        yield* rideFilesIn(inner.src, host, depth + 1, `${name}/`);
      } finally {
        await inner.done();
      }
    } else if (isRideFile(e.name) && e.size <= MAX_FILE && e.packed <= MAX_FILE) {
      const raw = await src.read(await dataStart(src, e), e.packed);
      let data: Uint8Array;
      try {
        data = e.method === 8 ? inflateSync(raw, { out: new Uint8Array(e.size) }) : raw;
        if (data.length !== e.size) throw new Error('size');
      } catch {
        yield { name, data: new Uint8Array(0) }; // counted as unreadable
        continue;
      }
      yield { name, data };
    }
  }
}
