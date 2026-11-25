// The shapes an area can be: a circle, or a rectangle lined up with north. All
// the geometry that depends on the shape is here, so the rest of the app can
// treat areas alike. No Node, Electron or DOM here.
import type { Bounds } from './api.ts';
import { M_PER_DEG } from './track.ts';

export type Shape =
  | { kind: 'circle'; center: [number, number]; radius: number }
  /** [west, south, east, north]. */
  | { kind: 'rect'; box: Bounds };

/** Smallest and largest circle radius, in metres. */
export const MIN_AREA = 50;
export const MAX_AREA = 10_000;
/** Smallest and largest rectangle side, in metres: as wide as the smallest and largest circles. */
export const MIN_SIDE = MIN_AREA * 2;
export const MAX_SIDE = MAX_AREA * 2;

const RAD = Math.PI / 180;
const kLon = (lat: number) => Math.max(Math.cos(lat * RAD), 0.01) * M_PER_DEG;

/** A rectangle from two opposite corners, in any order. */
export function rectFrom(a: [number, number], b: [number, number]): Shape {
  return { kind: 'rect', box: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] };
}

/**
 * The shape two clicks make: a circle's centre then a point on its edge, or a
 * rectangle's two opposite corners. Kept no bigger than an area can be, so the
 * second click can be anywhere.
 */
export function drawnShape(kind: Shape['kind'], first: [number, number], second: [number, number]): Shape {
  if (kind === 'circle') {
    const [x, y] = projector(first).to(second);
    return { kind, center: first, radius: Math.min(MAX_AREA, Math.hypot(x, y)) };
  }
  // A metre short, so rounding in the file never makes it too big. Width is measured across the middle, as rectSize does.
  const max = MAX_SIDE - 1;
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  const dLat = clamp(second[1] - first[1], max / M_PER_DEG);
  const dLon = clamp(second[0] - first[0], max / kLon(first[1] + dLat / 2));
  return rectFrom(first, [first[0] + dLon, first[1] + dLat]);
}

/** Width and height of a rectangle in metres, measured across its middle. */
export function rectSize([w, s, e, n]: Bounds): [number, number] {
  return [(e - w) * kLon((s + n) / 2), (n - s) * M_PER_DEG];
}

/** Why a shape can't be an area, or null when it can. */
export function shapeProblem(s: Shape): string | null {
  if (s.kind === 'circle') {
    return s.radius >= MIN_AREA && s.radius <= MAX_AREA ? null : `A circle's radius should be ${MIN_AREA} m to ${MAX_AREA / 1000} km.`;
  }
  const [w, h] = rectSize(s.box);
  return Math.min(w, h) >= MIN_SIDE && Math.max(w, h) <= MAX_SIDE ? null : `A rectangle's sides should be ${MIN_SIDE} m to ${MAX_SIDE / 1000} km.`;
}

/** [west, south, east, north] around a shape. */
export function shapeBounds(s: Shape): Bounds {
  if (s.kind === 'rect') return [...s.box];
  const dLat = s.radius / M_PER_DEG;
  const dLon = s.radius / kLon(s.center[1]);
  return [s.center[0] - dLon, s.center[1] - dLat, s.center[0] + dLon, s.center[1] + dLat];
}

/** [west, south, east, north] around several shapes. */
export function shapesBounds(shapes: Shape[]): Bounds {
  return shapes.map(shapeBounds).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
}

export function shapeCenter(s: Shape): [number, number] {
  return s.kind === 'circle' ? s.center : [(s.box[0] + s.box[2]) / 2, (s.box[1] + s.box[3]) / 2];
}

/** Local flat coordinates in metres around a point. Accurate enough for 10 km. */
export function projector(center: [number, number]) {
  const k = Math.cos(center[1] * RAD) * M_PER_DEG;
  return {
    to: (p: [number, number]): [number, number] => [(p[0] - center[0]) * k, (p[1] - center[1]) * M_PER_DEG],
    from: (x: number, y: number): [number, number] => [center[0] + x / k, center[1] + y / M_PER_DEG],
  };
}

/** Is the point inside the shape (or on its edge)? */
export function insideShape(s: Shape, lon: number, lat: number): boolean {
  if (s.kind === 'rect') return lon >= s.box[0] && lon <= s.box[2] && lat >= s.box[1] && lat <= s.box[3];
  const [x, y] = projector(s.center).to([lon, lat]);
  return x * x + y * y <= s.radius * s.radius;
}

export const insideAny = (shapes: Shape[], lon: number, lat: number) => shapes.some((s) => insideShape(s, lon, lat));

/** A shape in local metres: whether a point is inside, and where a segment may cross its edge. */
function local(s: Shape, pr: ReturnType<typeof projector>) {
  if (s.kind === 'circle') {
    const [cx, cy] = pr.to(s.center);
    const r2 = s.radius * s.radius;
    return {
      inside: (p: [number, number]) => (p[0] - cx) ** 2 + (p[1] - cy) ** 2 <= r2,
      /** Fractions along a→b where it crosses the circle. */
      cuts(a: [number, number], b: [number, number]): number[] {
        const ax = a[0] - cx, ay = a[1] - cy, dx = b[0] - a[0], dy = b[1] - a[1];
        const A = dx * dx + dy * dy;
        if (A === 0) return [];
        const B = 2 * (ax * dx + ay * dy);
        const disc = B * B - 4 * A * (ax * ax + ay * ay - r2);
        if (disc <= 0) return [];
        const q = Math.sqrt(disc);
        return [(-B - q) / (2 * A), (-B + q) / (2 * A)];
      },
    };
  }
  const [x0, y0] = pr.to([s.box[0], s.box[1]]);
  const [x1, y1] = pr.to([s.box[2], s.box[3]]);
  return {
    inside: (p: [number, number]) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1,
    /** Fractions along a→b where it crosses any of the lines the sides lie on. Extra cuts are harmless. */
    cuts(a: [number, number], b: [number, number]): number[] {
      const out: number[] = [];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      if (dx) out.push((x0 - a[0]) / dx, (x1 - a[0]) / dx);
      if (dy) out.push((y0 - a[1]) / dy, (y1 - a[1]) / dy);
      return out;
    },
  };
}

/**
 * The parts of a line inside any of the shapes, cut exactly at their edges, with
 * their length in metres. Overlaps count once, so shapes joined into one area
 * never count a road twice.
 */
export function clipToShapes(line: [number, number][], shapes: Shape[]): { lines: [number, number][][]; length: number } {
  const out: [number, number][][] = [];
  let length = 0;
  if (!shapes.length || line.length < 2) return { lines: out, length };
  const pr = projector(shapeCenter(shapes[0]!));
  const ps = line.map(pr.to);
  const ls = shapes.map((s) => local(s, pr));
  const inside = (p: [number, number]) => ls.some((l) => l.inside(p));
  let cur: [number, number][] | null = null;
  let last: [number, number] | null = null;
  const add = (p: [number, number]) => {
    if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) return;
    if (last) length += Math.hypot(p[0] - last[0], p[1] - last[1]);
    cur!.push(pr.from(p[0], p[1]));
    last = p;
  };
  const end = () => {
    if (cur && cur.length >= 2) out.push(cur);
    cur = null;
    last = null;
  };
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1]!, b = ps[i]!;
    const at = (t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    // Cut the segment wherever it may cross an edge, and keep the pieces whose middle is inside a shape.
    const ts = [0, ...ls.flatMap((l) => l.cuts(a, b)).filter((t) => t > 0 && t < 1), 1].sort((x, y) => x - y);
    for (let j = 1; j < ts.length; j++) {
      const t0 = ts[j - 1]!, t1 = ts[j]!;
      if (t1 - t0 < 1e-12) continue;
      if (inside(at((t0 + t1) / 2))) {
        if (!cur) cur = [];
        add(at(t0));
        add(at(t1));
      } else end();
    }
  }
  end();
  return { lines: out, length };
}

/**
 * A shape's edge as a function: `at(u)` for u from 0 to `n` goes once around it,
 * and whole values of u are evenly spread points on it, corners included.
 */
function edge(s: Shape, steps: number): { n: number; at(u: number): [number, number] } {
  if (s.kind === 'circle') {
    const dLat = s.radius / M_PER_DEG;
    const dLon = s.radius / kLon(s.center[1]);
    return { n: steps, at: (u) => [s.center[0] + dLon * Math.cos((u / steps) * 2 * Math.PI), s.center[1] + dLat * Math.sin((u / steps) * 2 * Math.PI)] };
  }
  const [w, so, e, no] = s.box;
  const corners: [number, number][] = [[w, so], [e, so], [e, no], [w, no]];
  const per = Math.max(1, Math.round(steps / 4));
  return {
    n: per * 4,
    at(u) {
      u = ((u % (per * 4)) + per * 4) % (per * 4);
      const side = Math.min(3, Math.floor(u / per));
      const f = u / per - side;
      const a = corners[side]!, b = corners[(side + 1) % 4]!;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    },
  };
}

/** A closed ring around a shape, for drawing it filled. */
export function shapeRing(s: Shape, steps = 120): [number, number][] {
  if (s.kind === 'rect') {
    const [w, so, e, no] = s.box;
    return [[w, so], [e, so], [e, no], [w, no], [w, so]];
  }
  const { at } = edge(s, steps);
  const ring = Array.from({ length: steps }, (_, i) => at(i));
  ring.push(ring[0]!);
  return ring;
}

/** Strictly inside: a point on the edge of another shape does not hide this one's edge. */
function strictlyInside(s: Shape, p: [number, number]): boolean {
  if (s.kind === 'rect') return p[0] > s.box[0] && p[0] < s.box[2] && p[1] > s.box[1] && p[1] < s.box[3];
  const [x, y] = projector(s.center).to(p);
  return x * x + y * y < s.radius * s.radius;
}

/**
 * The outline around overlapping shapes: each shape's edge, less the parts
 * inside another shape. Lines for drawing; a lone shape gives its whole ring.
 */
export function unionEdge(shapes: Shape[], steps = 120): [number, number][][] {
  const inside = (p: [number, number], skip: number) => shapes.some((s, j) => j !== skip && strictlyInside(s, p));
  const out: [number, number][][] = [];
  shapes.forEach((s, i) => {
    const { n, at } = edge(s, steps);
    const keep = Array.from({ length: n }, (_, k) => !inside(at(k), i));
    if (keep.every(Boolean)) return out.push(shapeRing(s, steps));
    if (!keep.some(Boolean)) return;
    /** Where the edge crosses into or out of another shape, between two steps. */
    const cross = (a: number, b: number, inAtA: boolean): [number, number] => {
      for (let k = 0; k < 20; k++) {
        const m = (a + b) / 2;
        if (inside(at(m), i) === inAtA) a = m;
        else b = m;
      }
      return at((a + b) / 2);
    };
    // Start just after a step that is cut, so every kept run is whole.
    const start = keep.indexOf(false);
    let run: [number, number][] = [];
    for (let k = start + 1; k <= start + n; k++) {
      const cur = k % n;
      const prev = (k - 1) % n;
      if (keep[cur]) {
        if (!keep[prev]) run.push(cross(k - 1, k, true));
        run.push(at(cur));
      } else if (keep[prev]) {
        run.push(cross(k - 1, k, false));
        out.push(run);
        run = [];
      }
    }
  });
  return out;
}
