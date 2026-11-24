// Merges rides into one network of trail sections, each with a count of passes.
// See "Building the heatmap" in the ARD.
import { M_PER_DEG, type Track } from './track.ts';

export interface HeatOptions {
  /** Metres within which a ride counts as being on an existing section. */
  radius: number;
  /** Largest difference in direction, in degrees, either way along the section. */
  angle: number;
  /** Length of the pieces that make up new sections, in metres. */
  step: number;
  /** Lowest count of each colour band. Neighbouring sections in one band are drawn as one line. */
  bands: number[];
}
/** Lowest count of each colour band: 1, 2-3, 4-7, 8-15, 16-39, 40+. */
export const BANDS = [1, 2, 4, 8, 16, 40];
export const DEFAULTS: HeatOptions = { radius: 15, angle: 35, step: 10, bands: BANDS };

export const bandOf = (n: number, bands: number[] = BANDS): number => {
  let b = 0;
  while (b + 1 < bands.length && n >= bands[b + 1]!) b++;
  return b;
};

export interface HeatLine {
  /** Passes. */
  n: number;
  /** lon, lat pairs. */
  coords: [number, number][];
}
export interface Heatmap {
  lines: HeatLine[];
  /** One dot per riding area, for views too far out to show lines. */
  dots: { n: number; at: [number, number] }[];
  /** West, south, east, north of where most of the riding is. */
  focus: [number, number, number, number] | null;
}

const RAD = Math.PI / 180;
const CELL = 30; // metres
const COLS = 4_000_000;
const SAMPLE = 5; // metres between checks along a ride
const BLIP = 30; // shorter wanderings off a section are GPS noise
const TAIL = 40; // the newest part of a ride is not yet matchable by itself
const OWN_RECENT = 250; // path metres within which a ride may be a hairpin beside itself
const OWN_RADIUS = 6;
const RECOUNT_SAME = 100; // path metres before the same way counts again
const RECOUNT_BACK = 50; // path metres before the way back counts
const MAX_SHIFT = 5; // metres a section may move towards the average of its rides
const BRIDGE_HOPS = 8;

class Net {
  // nodes
  lon: number[] = [];
  lat: number[] = [];
  lon0: number[] = [];
  lat0: number[] = [];
  weight: number[] = [];
  edgesAt: number[][] = [];
  // edges
  a: number[] = [];
  b: number[] = [];
  count: number[] = [];
  lastRide: number[] = [];
  lastDir: number[] = [];
  lastPos: number[] = [];
  grid = new Map<number, number[]>();

  addNode(lon: number, lat: number): number {
    this.lon.push(lon);
    this.lat.push(lat);
    this.lon0.push(lon);
    this.lat0.push(lat);
    this.weight.push(1);
    this.edgesAt.push([]);
    return this.lon.length - 1;
  }
  edgeBetween(a: number, b: number): number {
    for (const e of this.edgesAt[a]!) if (this.a[e] === b || this.b[e] === b) return e;
    return -1;
  }
  addEdge(a: number, b: number): number {
    const had = a === b ? -1 : this.edgeBetween(a, b);
    if (had >= 0 || a === b) return had;
    const e = this.a.length;
    this.a.push(a);
    this.b.push(b);
    this.count.push(0);
    this.lastRide.push(-1);
    this.lastDir.push(0);
    this.lastPos.push(-Infinity);
    this.edgesAt[a]!.push(e);
    this.edgesAt[b]!.push(e);
    const key = cellKey((this.lon[a]! + this.lon[b]!) / 2, (this.lat[a]! + this.lat[b]!) / 2);
    const cell = this.grid.get(key);
    if (cell) cell.push(e);
    else this.grid.set(key, [e]);
    return e;
  }
}

const rowOf = (lat: number) => Math.floor(((lat + 90) * M_PER_DEG) / CELL);
const colOf = (lon: number, row: number) => {
  const c = Math.cos((((row + 0.5) * CELL) / M_PER_DEG - 90) * RAD);
  return Math.floor(((lon + 180) * M_PER_DEG * c) / CELL);
};
const cellKey = (lon: number, lat: number) => {
  const r = rowOf(lat);
  return r * COLS + colOf(lon, r);
};

interface Sample {
  lon: number;
  lat: number;
  dx: number; // unit direction
  dy: number;
  pos: number; // metres along the ride
}

/** Evenly spaced samples along one line. */
function sample(line: Float64Array, from: number): Sample[] {
  const out: Sample[] = [];
  let carry = 0;
  let pos = from;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const lon = line[i]!;
    const lat = line[i + 1]!;
    const kx = M_PER_DEG * Math.cos(lat * RAD);
    const x = (line[i + 2]! - lon) * kx;
    const y = (line[i + 3]! - lat) * M_PER_DEG;
    const len = Math.hypot(x, y);
    if (len === 0) continue;
    for (let d = carry; d < len; d += SAMPLE) {
      out.push({ lon: lon + ((x / len) * d) / kx, lat: lat + ((y / len) * d) / M_PER_DEG, dx: x / len, dy: y / len, pos: pos + d });
    }
    carry = (SAMPLE - ((len - carry) % SAMPLE)) % SAMPLE;
    pos += len;
  }
  const n = line.length;
  const prev = out.at(-1);
  if (prev && pos - prev.pos > 1) out.push({ ...prev, lon: line[n - 2]!, lat: line[n - 1]!, pos });
  // Direction over about 15 m, which is steadier than point to point.
  return out.map((s, i) => {
    const p = out[Math.max(0, i - 1)]!;
    const q = out[Math.min(out.length - 1, i + 2)]!;
    const kx = M_PER_DEG * Math.cos(s.lat * RAD);
    const x = (q.lon - p.lon) * kx;
    const y = (q.lat - p.lat) * M_PER_DEG;
    const l = Math.hypot(x, y);
    return l > 0 ? { ...s, dx: x / l, dy: y / l } : s;
  });
}

export class HeatmapBuilder {
  private net = new Net();
  private ride = 0;
  private opt: HeatOptions;
  private cosMax: number;

  constructor(opt: Partial<HeatOptions> = {}) {
    this.opt = { ...DEFAULTS, ...opt };
    this.cosMax = Math.cos(this.opt.angle * RAD);
  }

  addRide(track: Track): void {
    const ride = this.ride++;
    let from = 0;
    for (const line of track) {
      const s = sample(line, from);
      if (s.length) {
        this.addLine(s, ride);
        // A gap is not a turn-around, so keep positions well apart.
        from = s.at(-1)!.pos + 10 * OWN_RECENT;
      }
    }
  }

  private addLine(samples: Sample[], ride: number): void {
    let prevEdge = -1; // last section this ride was on
    let pending: Sample[] = []; // samples on no known section yet
    let anchor = -1; // node that new pieces continue from

    for (const s of samples) {
      const m = this.match(s, ride, prevEdge);
      if (m < 0) {
        pending.push(s);
        // Commit all but the newest part, so laps in one ride can find themselves.
        if (s.pos - pending[0]!.pos > BLIP + 3 * TAIL) {
          const cut = pending.findIndex((p) => p.pos > s.pos - TAIL);
          anchor = this.create(pending.slice(0, cut), anchor >= 0 ? anchor : this.exit(prevEdge, pending[0]!), ride);
          pending = pending.slice(cut);
          prevEdge = -1;
        }
        continue;
      }
      if (pending.length) {
        const span = s.pos - pending[0]!.pos;
        const blip = anchor < 0 && prevEdge >= 0 && span < BLIP;
        if (!blip) {
          const start = anchor >= 0 ? anchor : this.exit(prevEdge, pending[0]!);
          const end = this.create(pending, start, ride);
          const join = this.exit(m, pending.at(-1)!);
          if (end >= 0 && join >= 0) this.touch(this.net.addEdge(end, join), ride, 1, s.pos);
          prevEdge = -1;
        }
        pending = [];
        anchor = -1;
      }
      if (prevEdge >= 0 && prevEdge !== m) this.bridge(prevEdge, m, ride, s);
      this.touch(m, ride, this.dir(m, s), s.pos);
      this.pull(m, s);
      prevEdge = m;
      anchor = -1;
    }
    if (pending.length) {
      const span = pending.at(-1)!.pos - pending[0]!.pos;
      if (anchor >= 0 || prevEdge < 0 || span >= BLIP) {
        this.create(pending, anchor >= 0 ? anchor : this.exit(prevEdge, pending[0]!), ride);
      }
    }
  }

  private dir(e: number, s: Sample): number {
    const { a, b, lon, lat } = this.net;
    const x = (lon[b[e]!]! - lon[a[e]!]!) * Math.cos(s.lat * RAD);
    const y = lat[b[e]!]! - lat[a[e]!]!;
    return x * s.dx + y * s.dy >= 0 ? 1 : -1;
  }

  /** Best existing section for a sample, or -1. */
  private match(s: Sample, ride: number, prevEdge: number): number {
    const n = this.net;
    const row = rowOf(s.lat);
    const kx = M_PER_DEG * Math.cos(s.lat * RAD);
    let best = -1;
    let bestCost = Infinity;
    for (let r = row - 1; r <= row + 1; r++) {
      const col = colOf(s.lon, r);
      for (let c = col - 1; c <= col + 1; c++) {
        const cell = n.grid.get(r * COLS + c);
        if (!cell) continue;
        for (const e of cell) {
          const a = n.a[e]!;
          const b = n.b[e]!;
          const ax = (n.lon[a]! - s.lon) * kx;
          const ay = (n.lat[a]! - s.lat) * M_PER_DEG;
          const ex = (n.lon[b]! - n.lon[a]!) * kx;
          const ey = (n.lat[b]! - n.lat[a]!) * M_PER_DEG;
          const len2 = ex * ex + ey * ey;
          if (len2 < 0.01) continue;
          const cos = Math.abs(ex * s.dx + ey * s.dy) / Math.sqrt(len2);
          if (cos < this.cosMax) continue;
          const t = Math.max(0, Math.min(1, -(ax * ex + ay * ey) / len2));
          const d = Math.hypot(ax + ex * t, ay + ey * t);
          // Beside its own recent path, a ride is more likely on a hairpin
          // than exactly retracing, so ask for a closer fit.
          const own = n.lastRide[e] === ride && s.pos - n.lastPos[e]! < OWN_RECENT && n.lastDir[e] !== this.dir(e, s);
          if (d > (own ? OWN_RADIUS : this.opt.radius)) continue;
          let cost = d + (1 - cos) * 20;
          if (prevEdge >= 0 && (e === prevEdge || this.adjacent(e, prevEdge))) cost -= 4;
          if (cost < bestCost) {
            bestCost = cost;
            best = e;
          }
        }
      }
    }
    return best;
  }

  private adjacent(e: number, f: number): boolean {
    const { a, b } = this.net;
    return a[e] === a[f] || a[e] === b[f] || b[e] === a[f] || b[e] === b[f];
  }

  private touch(e: number, ride: number, dir: number, pos: number): void {
    if (e < 0) return;
    const n = this.net;
    const gap = pos - n.lastPos[e]!;
    const again = n.lastRide[e] !== ride || gap > (dir === n.lastDir[e] ? RECOUNT_SAME : RECOUNT_BACK);
    if (again) {
      n.count[e]!++;
      n.lastDir[e] = dir;
    }
    n.lastRide[e] = ride;
    n.lastPos[e] = pos;
  }

  /** Nearest end of a section, where new pieces attach. */
  private exit(e: number, s: Sample): number {
    if (e < 0) return -1;
    const { a, b, lon, lat } = this.net;
    const k = Math.cos(s.lat * RAD);
    const da = Math.hypot((lon[a[e]!]! - s.lon) * k, lat[a[e]!]! - s.lat);
    const db = Math.hypot((lon[b[e]!]! - s.lon) * k, lat[b[e]!]! - s.lat);
    return da <= db ? a[e]! : b[e]!;
  }

  /** Make new pieces along the samples. Returns the last node. */
  private create(samples: Sample[], start: number, ride: number): number {
    const n = this.net;
    let node = start;
    const every = Math.max(1, Math.round(this.opt.step / SAMPLE));
    for (let i = 0; i < samples.length; i += every) {
      const s = samples[i]!;
      const next = n.addNode(s.lon, s.lat);
      if (node >= 0) {
        const e = n.addEdge(node, next);
        this.touch(e, ride, 1, s.pos);
      }
      node = next;
    }
    return node;
  }

  /** Count short pieces that were skipped between two matches. */
  private bridge(from: number, to: number, ride: number, s: Sample): void {
    if (this.adjacent(from, to)) return;
    const n = this.net;
    const came = new Map<number, number>(); // edge -> previous edge
    let frontier = [from];
    came.set(from, -1);
    for (let hop = 0; hop < BRIDGE_HOPS && frontier.length; hop++) {
      const next: number[] = [];
      for (const e of frontier) {
        for (const node of [n.a[e]!, n.b[e]!]) {
          for (const f of n.edgesAt[node]!) {
            if (came.has(f)) continue;
            came.set(f, e);
            if (f === to) {
              for (let g = came.get(to)!; g !== from && g >= 0; g = came.get(g)!) this.touch(g, ride, this.dir(g, s), s.pos);
              return;
            }
            next.push(f);
          }
        }
      }
      frontier = next;
    }
  }

  /** Move a section slightly towards the ride, so it settles on the average. */
  private pull(e: number, s: Sample): void {
    const n = this.net;
    const node = this.exit(e, s);
    const a = n.a[e]!;
    const b = n.b[e]!;
    const kx = M_PER_DEG * Math.cos(s.lat * RAD);
    const ex = (n.lon[b]! - n.lon[a]!) * kx;
    const ey = (n.lat[b]! - n.lat[a]!) * M_PER_DEG;
    const len = Math.hypot(ex, ey);
    if (len < 0.1) return;
    const nx = -ey / len;
    const ny = ex / len;
    const off = (s.lon - n.lon[a]!) * kx * nx + (s.lat - n.lat[a]!) * M_PER_DEG * ny;
    const w = (n.weight[node] = Math.min(60, n.weight[node]! + 0.5));
    let x = (n.lon[node]! - n.lon0[node]!) * kx + (nx * off) / w;
    let y = (n.lat[node]! - n.lat0[node]!) * M_PER_DEG + (ny * off) / w;
    const shift = Math.hypot(x, y);
    if (shift > MAX_SHIFT) {
      x *= MAX_SHIFT / shift;
      y *= MAX_SHIFT / shift;
    }
    n.lon[node] = n.lon0[node]! + x / kx;
    n.lat[node] = n.lat0[node]! + y / M_PER_DEG;
  }

  /** Join pieces into lines of one colour band. */
  finish(): Heatmap {
    const n = this.net;
    const used = new Uint8Array(n.a.length);
    const lines: HeatLine[] = [];
    const deg = (v: number) => n.edgesAt[v]!.length;

    const walk = (e0: number, v0: number) => {
      // Follow from node v0 through e0 until a junction or an end.
      const nodes = [v0];
      const edges: number[] = [];
      let e = e0;
      let v = v0;
      for (;;) {
        used[e] = 1;
        edges.push(e);
        v = n.a[e] === v ? n.b[e]! : n.a[e]!;
        nodes.push(v);
        if (deg(v) !== 2) break;
        const next = n.edgesAt[v]!.find((f) => !used[f]);
        if (next === undefined) break;
        e = next;
      }
      this.emit(nodes, edges, lines);
    };
    for (let v = 0; v < n.lon.length; v++) {
      if (deg(v) === 2) continue;
      for (const e of n.edgesAt[v]!) if (!used[e]) walk(e, v);
    }
    for (let e = 0; e < n.a.length; e++) if (!used[e]) walk(e, n.a[e]!); // closed loops
    lines.sort((p, q) => p.n - q.n);
    return { lines, dots: dots(lines), focus: this.focus() };
  }

  private emit(nodes: number[], edges: number[], lines: HeatLine[]): void {
    const n = this.net;
    const raw = edges.map((e) => Math.max(1, n.count[e]!));
    // A stray stub off a known trail is noise.
    const dangling = n.edgesAt[nodes[0]!]!.length === 1 || n.edgesAt[nodes.at(-1)!]!.length === 1;
    const joined = n.edgesAt[nodes[0]!]!.length > 2 || n.edgesAt[nodes.at(-1)!]!.length > 2;
    if (dangling && joined && edges.length <= 3 && Math.max(...raw) === 1) return;
    // Between junctions the count should be steady, so smooth out misses.
    const counts = raw.map((_, i) => {
      const w = raw.slice(Math.max(0, i - 5), i + 6).sort((p, q) => p - q);
      return w[w.length >> 1]!;
    });
    let i = 0;
    while (i < edges.length) {
      let j = i;
      while (j + 1 < edges.length && bandOf(counts[j + 1]!, this.opt.bands) === bandOf(counts[i]!, this.opt.bands)) j++;
      const part = counts.slice(i, j + 1).sort((p, q) => p - q);
      lines.push({
        n: part[part.length >> 1]!,
        coords: simplify(nodes.slice(i, j + 2).map((v) => [n.lon[v]!, n.lat[v]!]), 2),
      });
      i = j + 1;
    }
  }

  /** The area holding the bulk of the riding, for the opening view. */
  private focus(): Heatmap['focus'] {
    const n = this.net;
    if (!n.a.length) return null;
    const boxes = new Map<string, number>();
    for (let e = 0; e < n.a.length; e++) {
      const v = n.a[e]!;
      const k = `${Math.floor(n.lon[v]! * 2)},${Math.floor(n.lat[v]! * 2)}`;
      boxes.set(k, (boxes.get(k) ?? 0) + n.count[e]!);
    }
    const [cx, cy] = [...boxes].sort((p, q) => q[1] - p[1])[0]![0].split(',').map(Number) as [number, number];
    const xs: number[] = [];
    const ys: number[] = [];
    for (let v = 0; v < n.lon.length; v++) {
      if (Math.abs(Math.floor(n.lon[v]! * 2) - cx) <= 1 && Math.abs(Math.floor(n.lat[v]! * 2) - cy) <= 1) {
        xs.push(n.lon[v]!);
        ys.push(n.lat[v]!);
      }
    }
    xs.sort((p, q) => p - q);
    ys.sort((p, q) => p - q);
    const at = (v: number[], f: number) => v[Math.min(v.length - 1, Math.floor(v.length * f))]!;
    return [at(xs, 0.03), at(ys, 0.03), at(xs, 0.97), at(ys, 0.97)];
  }
}

function dots(lines: HeatLine[]): Heatmap['dots'] {
  const cells = new Map<string, { n: number; x: number; y: number; k: number }>();
  for (const l of lines) {
    const [x, y] = l.coords[0]!;
    const key = `${Math.floor(x * 5)},${Math.floor(y * 5)}`;
    const c = cells.get(key) ?? { n: 0, x: 0, y: 0, k: 0 };
    cells.set(key, { n: Math.max(c.n, l.n), x: c.x + x, y: c.y + y, k: c.k + 1 });
  }
  return [...cells.values()].map((c) => ({ n: c.n, at: [c.x / c.k, c.y / c.k] as [number, number] })).sort((a, b) => a.n - b.n);
}

/** Drop points that barely change the line (Douglas-Peucker, metres). */
export function simplify(p: [number, number][], tol: number): [number, number][] {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const kx = M_PER_DEG * Math.cos(p[i]![1] * RAD);
    const ex = (p[j]![0] - p[i]![0]) * kx;
    const ey = (p[j]![1] - p[i]![1]) * M_PER_DEG;
    const len2 = ex * ex + ey * ey;
    let far = -1;
    let max = tol;
    for (let k = i + 1; k < j; k++) {
      const x = (p[k]![0] - p[i]![0]) * kx;
      const y = (p[k]![1] - p[i]![1]) * M_PER_DEG;
      const t = len2 ? Math.max(0, Math.min(1, (x * ex + y * ey) / len2)) : 0;
      const d = Math.hypot(x - ex * t, y - ey * t);
      if (d > max) {
        max = d;
        far = k;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  return p.filter((_, i) => keep[i]);
}

export function toGeoJson(h: Heatmap): string {
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [
      ...h.lines.map((l) => ({
        type: 'Feature',
        properties: { n: l.n },
        geometry: { type: 'LineString', coordinates: l.coords.map(([x, y]) => [r(x), r(y)]) },
      })),
      ...h.dots.map((d) => ({ type: 'Feature', properties: { n: d.n }, geometry: { type: 'Point', coordinates: [r(d.at[0]), r(d.at[1])] } })),
    ],
  });
}
