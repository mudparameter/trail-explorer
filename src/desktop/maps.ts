import { randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, inflateSync } from 'node:zlib';
import { Unzip, UnzipInflate } from 'fflate';
import { PMTiles, TileType, type RangeResponse, type Source } from 'pmtiles';
import type { Bounds, MapInfo } from '../core/api.ts';

const MAX_MAP = 20 * 1024 ** 3;
const MAX_TILE = 30 * 1024 ** 2;
const SCAN_TILES = 4000;
const HELP = 'Trail Explorer reads .pmtiles and .mbtiles maps, or a BBBike .zip with one inside.';

export interface TileData {
  data: Uint8Array;
  type: string;
}
interface Reader {
  tile(z: number, x: number, y: number): Promise<Uint8Array | null>;
  meta: { kind: 'vector' | 'raster'; minzoom: number; maxzoom: number; bounds: Bounds; layers: string[]; attribution: string };
  close(): Promise<void>;
}

async function magic(file: string): Promise<'pmtiles' | 'mbtiles' | 'zip' | null> {
  const h = await open(file);
  try {
    const b = Buffer.alloc(16);
    await h.read(b, 0, 16, 0);
    if (b.subarray(0, 7).toString('latin1') === 'PMTiles') return b[7] === 3 ? 'pmtiles' : null;
    if (b.toString('latin1') === 'SQLite format 3\0') return 'mbtiles';
    if (b.readUInt32BE(0) === 0x504b0304) return 'zip';
    return null;
  } finally {
    await h.close();
  }
}

export const tileX = (lon: number, z: number) => Math.min(2 ** z - 1, Math.max(0, Math.floor(((lon + 180) / 360) * 2 ** z)));
export const tileY = (lat: number, z: number) => {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return Math.min(2 ** z - 1, Math.max(0, Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z)));
};
const lonOf = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const latOf = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

const num = (v: unknown, d: number) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const zoom = (v: unknown, d: number) => Math.max(0, Math.min(24, Math.round(num(v, d))));
function okBounds(b: number[]): Bounds {
  const [w, s, e, n] = b;
  if (b.length === 4 && b.every(Number.isFinite) && w! < e! && s! < n!) {
    return [Math.max(-180, w!), Math.max(-85.05, s!), Math.min(180, e!), Math.min(85.05, n!)];
  }
  return [-180, -85.05, 180, 85.05];
}
const layerIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((l) => l?.id).filter((x): x is string => typeof x === 'string' && x.length < 200).slice(0, 200) : [];
const plain = (v: unknown) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').slice(0, 200) : '');

/** Tiles are stored gzipped, zlibbed or plain. */
function unpack(d: Uint8Array): Uint8Array {
  if (d[0] === 0x1f && d[1] === 0x8b) return gunzipSync(d, { maxOutputLength: MAX_TILE });
  if (d[0] === 0x78 && (d[1] === 0x9c || d[1] === 0x01 || d[1] === 0xda)) return inflateSync(d, { maxOutputLength: MAX_TILE });
  return d;
}

class FileSource implements Source {
  private h: FileHandle;
  private key: string;
  constructor(h: FileHandle, key: string) {
    this.h = h;
    this.key = key;
  }
  getKey() {
    return this.key;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    if (length < 0 || length > 100 * 1024 ** 2) throw new Error('The map file is damaged.');
    const b = new Uint8Array(length);
    const { bytesRead } = await this.h.read(b, 0, length, offset);
    return { data: b.buffer.slice(0, bytesRead) };
  }
}

async function openPmtiles(file: string): Promise<Reader> {
  const h = await open(file);
  try {
    const pm = new PMTiles(new FileSource(h, file));
    const hd = await pm.getHeader();
    const m = ((await pm.getMetadata()) ?? {}) as Record<string, unknown>;
    if (![TileType.Mvt, TileType.Png, TileType.Jpeg, TileType.Webp, TileType.Avif].includes(hd.tileType)) {
      throw new Error('This map uses a tile format the app cannot draw.');
    }
    return {
      tile: async (z, x, y) => {
        const r = await pm.getZxy(z, x, y);
        return r ? unpack(new Uint8Array(r.data)) : null;
      },
      meta: {
        kind: hd.tileType === TileType.Mvt ? 'vector' : 'raster',
        minzoom: zoom(hd.minZoom, 0),
        maxzoom: zoom(hd.maxZoom, 14),
        bounds: okBounds([hd.minLon, hd.minLat, hd.maxLon, hd.maxLat]),
        layers: layerIds(m.vector_layers),
        attribution: plain(m.attribution),
      },
      close: () => h.close(),
    };
  } catch (e) {
    await h.close();
    throw e;
  }
}

function openMbtiles(file: string): Reader {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const m = Object.fromEntries(db.prepare('SELECT name, value FROM metadata LIMIT 200').all().map((r) => [String(r.name), String(r.value)]));
    const get = db.prepare('SELECT tile_data AS d FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ? LIMIT 1');
    let json: any = {};
    try {
      json = JSON.parse(m.json ?? '{}');
    } catch {}
    const format = (m.format ?? 'png').toLowerCase();
    const z = db.prepare('SELECT min(zoom_level) AS a, max(zoom_level) AS b FROM tiles').get()!;
    if (z.b === null) throw new Error('This map file has no tiles in it.');
    return {
      tile: async (zz, x, y) => {
        const r = get.get(zz, x, 2 ** zz - 1 - y);
        return r?.d instanceof Uint8Array ? unpack(r.d) : null;
      },
      meta: {
        kind: format === 'pbf' || format === 'mvt' ? 'vector' : 'raster',
        minzoom: zoom(z.a, 0),
        maxzoom: zoom(z.b, 14),
        bounds: okBounds((m.bounds ?? '').split(',').map(Number)),
        layers: layerIds(json.vector_layers),
        attribution: plain(m.attribution),
      },
      close: async () => db.close(),
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
const openMap = async (file: string): Promise<Reader> => ((await magic(file)) === 'pmtiles' ? openPmtiles(file) : openMbtiles(file));

/** Names of the layers present in a vector tile, without decoding it fully. */
export function layersIn(tile: Uint8Array): string[] {
  const names: string[] = [];
  let i = 0;
  const varint = () => {
    let v = 0;
    let s = 1;
    for (;;) {
      const b = tile[i++];
      if (b === undefined) throw new Error('bad tile');
      v += (b & 127) * s;
      if (b < 128) return v;
      s *= 128;
    }
  };
  try {
    while (i < tile.length) {
      const tag = varint();
      if ((tag & 7) !== 2) return names;
      const end = varint() + i;
      if (tag >> 3 === 3) {
        while (i < end) {
          const t = varint();
          if ((t & 7) === 0) varint();
          else if ((t & 7) === 2) {
            const n = varint();
            if (t >> 3 === 1) names.push(Buffer.from(tile.subarray(i, i + n)).toString());
            i += n;
          } else break;
        }
      }
      i = end;
    }
  } catch {}
  return names;
}

const CONTENT = new Set(['streets', 'street_labels', 'buildings', 'pois', 'place_labels', 'water_lines', 'land', 'sites']);

/**
 * Where a Shortbread map really has content. BBBike files can claim an area
 * reaching to longitude 0, filled with empty sea.
 */
async function realBounds(r: Reader): Promise<Bounds> {
  const [w, s, e, n] = r.meta.bounds;
  let z = r.meta.maxzoom;
  const span = (zz: number) => (tileX(e, zz) - tileX(w, zz) + 1) * (tileY(s, zz) - tileY(n, zz) + 1);
  while (z > 0 && span(z) > SCAN_TILES) z--;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let x = tileX(w, z); x <= tileX(e, z); x++) {
    for (let y = tileY(n, z); y <= tileY(s, z); y++) {
      const t = await r.tile(z, x, y);
      if (!t || !layersIn(t).some((l) => CONTENT.has(l))) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return r.meta.bounds;
  return okBounds([Math.max(w, lonOf(x0, z)), Math.max(s, latOf(y1 + 1, z)), Math.min(e, lonOf(x1 + 1, z)), Math.min(n, latOf(y0, z))]);
}

/** Pulls the first map out of a .zip, without holding it in memory. */
async function unzipMap(zip: string, dest: string): Promise<string> {
  let name: string | null = null;
  let failed: Error | null = null;
  let size = 0;
  let finished = false;
  const out = createWriteStream(dest);
  let drain: Promise<void> | null = null;
  out.on('error', (e) => (failed = e));
  const un = new Unzip((f) => {
    if (name || !/\.(pmtiles|mbtiles)$/i.test(f.name) || /(^|\/)(\._|__MACOSX)/.test(f.name)) return;
    name = basename(f.name);
    f.ondata = (err, chunk, final) => {
      if (err) failed = err;
      else {
        size += chunk.length;
        if (size > MAX_MAP) failed = new Error('The map inside this .zip is too large.');
        else if (chunk.length && !out.write(chunk)) drain ??= new Promise((r) => out.once('drain', () => { drain = null; r(); }));
        if (final) finished = true;
      }
    };
    f.start();
  });
  un.register(UnzipInflate);
  try {
    for await (const chunk of createReadStream(zip, { highWaterMark: 1 << 18 })) {
      un.push(chunk as Uint8Array);
      if (failed) throw failed;
      if (drain) await drain;
      if (finished) break;
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    throw e;
  }
  if (!name) throw new Error(`There is no map in this .zip. ${HELP}`);
  if (!finished) throw new Error('This .zip is incomplete. Try downloading it again.');
  return name;
}

export class Maps {
  private dir: string;
  private open = new Map<string, Promise<Reader>>();
  private files = new Map<string, string>();

  constructor(dir: string) {
    this.dir = dir;
  }
  register(id: string, file: string) {
    this.files.set(id, join(this.dir, basename(file)));
  }

  async add(path: string): Promise<{ file: string; info: MapInfo }> {
    await mkdir(this.dir, { recursive: true });
    const st = await stat(path);
    if (!st.isFile()) throw new Error(HELP);
    if (st.size > MAX_MAP) throw new Error('This map file is too large.');
    const id = randomUUID();
    const tmp = join(this.dir, `${id}.part`);
    try {
      let label = basename(path);
      const kind = await magic(path);
      if (kind === 'zip') label = await unzipMap(path, tmp);
      else if (kind) await copyFile(path, tmp, constants.COPYFILE_FICLONE);
      else throw new Error(`This file is not a map the app can read. ${HELP}`);
      const inner = await magic(tmp);
      if (inner !== 'pmtiles' && inner !== 'mbtiles') throw new Error(`This file is not a map the app can read. ${HELP}`);
      let r: Reader;
      try {
        r = await openMap(tmp);
      } catch (e) {
        throw new Error(`This map file could not be read. ${e instanceof Error ? e.message : ''}`.trim());
      }
      try {
        const shortbread = r.meta.kind === 'vector' && r.meta.layers.includes('streets') && r.meta.layers.includes('water_polygons');
        const info: MapInfo = {
          id,
          name: label.replace(/\.(pmtiles|mbtiles|zip)$/i, '').replace(/\.osm$/i, '').slice(0, 100) || 'Map',
          kind: r.meta.kind === 'raster' ? 'raster' : shortbread ? 'shortbread' : 'vector',
          bounds: shortbread ? await realBounds(r) : r.meta.bounds,
          minzoom: r.meta.minzoom,
          maxzoom: r.meta.maxzoom,
          layers: r.meta.layers,
          attribution: r.meta.attribution || '© OpenStreetMap contributors',
        };
        const file = `${id}.${inner}`;
        await r.close();
        await copyFile(tmp, join(this.dir, file), constants.COPYFILE_FICLONE);
        this.register(id, file);
        return { file, info };
      } catch (e) {
        await r.close().catch(() => {});
        throw e;
      }
    } finally {
      await rm(tmp, { force: true });
    }
  }
  async remove(id: string) {
    const file = this.files.get(id);
    const r = this.open.get(id);
    this.open.delete(id);
    this.files.delete(id);
    if (r) await r.then((x) => x.close()).catch(() => {});
    if (file) await rm(file, { force: true });
  }
  async close() {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.all(all.map((r) => r.then((x) => x.close()).catch(() => {})));
  }
  async tile(id: string, z: number, x: number, y: number): Promise<TileData | null> {
    const file = this.files.get(id);
    if (!file) return null;
    let r = this.open.get(id);
    if (!r) {
      r = openMap(file);
      this.open.set(id, r);
      r.catch(() => this.open.delete(id));
    }
    const reader = await r;
    const data = await reader.tile(z, x, y);
    if (!data) return null;
    return { data, type: reader.meta.kind === 'vector' ? 'application/x-protobuf' : imageType(data) };
  }
}
function imageType(d: Uint8Array): string {
  if (d[0] === 0x89) return 'image/png';
  if (d[0] === 0xff) return 'image/jpeg';
  if (d[8] === 0x57) return 'image/webp';
  return 'image/avif';
}
