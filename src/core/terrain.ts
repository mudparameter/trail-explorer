// Ground elevation from the free AWS Terrain Tiles (Terrarium encoding), and a
// small PNG decoder for them. No Electron or DOM code here.
//
// Each tile is a 256×256 PNG whose pixels hold elevation as
// (red × 256 + green + blue / 256) − 32768 metres. The data is a mix of sources:
// about 10 m in the USA, SRTM's 30 m in most other places, finer in some. See
// https://github.com/tilezen/joerd/blob/master/docs/attribution.md
import { unzlibSync } from 'fflate';

export const TERRAIN_ZOOM = 14;
export const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
export const TERRAIN_ATTRIBUTION = 'Elevation: Mapzen Terrain Tiles on AWS (USGS 3DEP, SRTM, GMTED2010, ETOPO1 and others)';
const SIZE = 256;

/** The terrain tiles covering a box, as [x, y] at TERRAIN_ZOOM. */
export function terrainTiles([w, s, e, n]: [number, number, number, number], max = 2000): [number, number][] {
  const [x0, y0] = tileOf(w, n);
  const [x1, y1] = tileOf(e, s);
  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (count > max) throw new Error(`That needs ${count} elevation tiles, more than the ${max} allowed.`);
  const out: [number, number][] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
}

/** Fractional tile position at TERRAIN_ZOOM. */
function position(lon: number, lat: number): [number, number] {
  const n = 2 ** TERRAIN_ZOOM;
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
}
const tileOf = (lon: number, lat: number): [number, number] => position(lon, lat).map(Math.floor) as [number, number];

/** Elevations in metres from a Terrarium PNG, row by row. */
export function decodeTerrarium(png: Uint8Array): Float32Array {
  const { width, height, channels, data } = decodePng(png);
  if (width !== SIZE || height !== SIZE) throw new Error('An elevation tile has an unexpected size.');
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const p = i * channels;
    out[i] = data[p]! * 256 + data[p + 1]! + data[p + 2]! / 256 - 32768;
  }
  return out;
}

/** Ground elevation anywhere covered by the tiles `get` returns. */
export class Elevation {
  private get: (x: number, y: number) => Float32Array | null;
  constructor(get: (x: number, y: number) => Float32Array | null) {
    this.get = get;
  }

  /** Metres, or NaN where there is no tile. Bilinear between pixel centres. */
  at(lon: number, lat: number): number {
    const [fx, fy] = position(lon, lat);
    const px = fx * SIZE - 0.5;
    const py = fy * SIZE - 0.5;
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const tx = px - x0;
    const ty = py - y0;
    const v = (x: number, y: number) => {
      const t = this.get(Math.floor(x / SIZE), Math.floor(y / SIZE));
      return t ? t[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)]! : NaN;
    };
    const a = v(x0, y0), b = v(x0 + 1, y0), c = v(x0, y0 + 1), d = v(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
}

// --- PNG ---------------------------------------------------------------------------

/** Decodes an 8-bit, non-interlaced greyscale, RGB or RGBA PNG. Enough for terrain tiles. */
export function decodePng(png: Uint8Array): { width: number; height: number; channels: number; data: Uint8Array } {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 33 || sig.some((b, i) => png[i] !== b)) throw new Error('Not a PNG file.');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0, height = 0, channels = 0;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= png.length; ) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!);
    const body = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      const depth = body[8], color = body[9], interlace = body[12];
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color!] ?? 0;
      if (depth !== 8 || !channels || interlace !== 0) throw new Error('Unsupported PNG format.');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!width || !idat.length) throw new Error('The PNG file is incomplete.');
  const total = idat.reduce((n, b) => n + b.length, 0);
  const joined = new Uint8Array(total);
  idat.reduce((at, b) => (joined.set(b, at), at + b.length), 0);
  const raw = unzlibSync(joined);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('The PNG file is incomplete.');
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]!;
      const a = i >= channels ? out[row + i - channels]! : 0;
      const b = y ? out[row - stride + i]! : 0;
      const c = y && i >= channels ? out[row - stride + i - channels]! : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error('The PNG file is damaged.');
      out[row + i] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}
