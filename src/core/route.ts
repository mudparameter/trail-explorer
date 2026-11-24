// What a planned route is like: its elevation profile, steep parts and how hard
// it is, in metric and imperial, and its GPX file. No Electron or DOM code here.
import type { Planned } from './planner.ts';
import type { RoadKind } from './roads.ts';
import { metres } from './track.ts';

/** Metres between elevation samples. */
const STEP = 10;
/** Grades are measured over this many metres, so one noisy sample doesn't count. */
const WINDOW = 50;
/** Climbs and descents at least this steep (%) are listed. */
export const STEEP = 15;

export interface Steep {
  /** Metres from the start. */
  from: number;
  to: number;
  /** Steepest grade in the section, in %, positive. */
  grade: number;
}

export interface RouteStats {
  distance: number;
  gain: number;
  loss: number;
  minEle: number | null;
  maxEle: number | null;
  /** Steepest climb and descent over WINDOW metres, in %, positive. */
  maxUp: number;
  maxDown: number;
  steepUp: Steep[];
  steepDown: Steep[];
  /** [metres from start, elevation], about 400 points at most. */
  profile: [number, number][];
}

export type Difficulty = 'Easy' | 'Moderate' | 'Hard' | 'Very hard';
export interface Rating {
  difficulty: Difficulty;
  /** 1 to 4, to sort and draw by. */
  level: 1 | 2 | 3 | 4;
  /** Why, in a few words each. */
  reasons: string[];
}

/** A route as the planner shows it and saves it. */
export interface PlannedRoute {
  id: string;
  name: string;
  loop: boolean;
  /** lon, lat, elevation (NaN where unknown). */
  line: [number, number, number][];
  stats: RouteStats;
  rating: Rating;
  /** Metres on trail you haven't ridden. */
  fresh: number;
  repeated: number;
  /** Metres on your favourite trails, when they were asked for. */
  favorite?: number;
  kinds: Partial<Record<RoadKind, number>>;
  /** mtb:scale (or sac_scale on the same 0–6 scale), where tagged. */
  level: number | null;
  restricted: boolean;
}

/**
 * A line with a point at least every STEP metres, each with its elevation,
 * smoothed a little. This is what a route keeps and its GPX file holds, so its
 * stats come out the same wherever they are worked out.
 */
export function elevated(line: [number, number][], ele: (lon: number, lat: number) => number): [number, number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < line.length; i++) {
    const [x, y] = line[i]!;
    if (i) {
      const [x0, y0] = line[i - 1]!;
      const seg = metres(x0, y0, x, y);
      for (let at = STEP; at < seg - STEP / 2; at += STEP) pts.push([x0 + ((x - x0) * at) / seg, y0 + ((y - y0) * at) / seg]);
    }
    pts.push([x, y]);
  }
  const e = pts.map(([x, y]) => ele(x, y));
  // Fill gaps with the last known value, then smooth over 3 points.
  let last = e.find(Number.isFinite) ?? NaN;
  for (let i = 0; i < e.length; i++) {
    if (Number.isFinite(e[i])) last = e[i]!;
    else e[i] = last;
  }
  return pts.map(([x, y], i) => [
    +x.toFixed(6), +y.toFixed(6),
    Math.round(((e[Math.max(0, i - 1)]! + e[i]! + e[Math.min(e.length - 1, i + 1)]!) / 3) * 10) / 10,
  ]);
}

/** Edges shorter than this are too short to measure a grade on: the elevation data isn't that fine. */
const MIN_GRADE_RUN = 20;

/**
 * The steepest descent along a line, going each way, in %, measured like a
 * route's: over WINDOW metres (or the whole line, if shorter). NaN where elevation is unknown.
 */
export function steepestDescents(line: [number, number][], ele: (lon: number, lat: number) => number): [number, number] {
  const pts = elevated(line, ele);
  const e = pts.map((p) => p[2]);
  if (!e.length || !e.every(Number.isFinite)) return [NaN, NaN];
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1]! + metres(pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1]));
  const total = d[d.length - 1]!;
  if (total < MIN_GRADE_RUN) return [0, 0];
  const w = Math.min(WINDOW, total);
  let fwd = 0, back = 0;
  let j = 0;
  for (let i = 0; i < d.length; i++) {
    while (j < d.length - 1 && d[j]! - d[i]! < w) j++;
    const run = d[j]! - d[i]!;
    if (run < w * 0.8) break;
    const g = ((e[j]! - e[i]!) / run) * 100;
    fwd = Math.max(fwd, -g);
    back = Math.max(back, g);
  }
  return [Math.round(fwd * 10) / 10, Math.round(back * 10) / 10];
}

/** Climbing, descending, steep parts and a profile from samples. */
export function statsOf(d: number[], e: number[]): RouteStats {
  const distance = d[d.length - 1] ?? 0;
  const known = e.every(Number.isFinite) && e.length > 0;
  let gain = 0, loss = 0;
  if (known) {
    // Changes smaller than this are noise in the data, not hills.
    const NOISE = 2;
    let ref = e[0]!;
    for (const v of e) {
      if (v - ref >= NOISE) {
        gain += v - ref;
        ref = v;
      } else if (ref - v >= NOISE) {
        loss += ref - v;
        ref = v;
      }
    }
  }
  const steepUp: Steep[] = [], steepDown: Steep[] = [];
  let maxUp = 0, maxDown = 0;
  if (known) {
    let j = 0;
    let open: { up: boolean; s: Steep } | null = null;
    for (let i = 0; i < d.length; i++) {
      while (j < d.length - 1 && d[j]! - d[i]! < WINDOW) j++;
      const run = d[j]! - d[i]!;
      if (run < WINDOW * 0.8) break;
      const g = ((e[j]! - e[i]!) / run) * 100;
      maxUp = Math.max(maxUp, g);
      maxDown = Math.max(maxDown, -g);
      const up = g >= STEEP, down = -g >= STEEP;
      if (open && ((open.up && up) || (!open.up && down))) {
        open.s.to = d[j]!;
        open.s.grade = Math.max(open.s.grade, Math.abs(g));
      } else {
        if (open) (open.up ? steepUp : steepDown).push(open.s);
        open = up || down ? { up, s: { from: d[i]!, to: d[j]!, grade: Math.abs(g) } } : null;
      }
    }
    if (open) (open.up ? steepUp : steepDown).push(open.s);
  }
  const every = Math.max(1, Math.ceil(d.length / 400));
  const profile: [number, number][] = [];
  for (let i = 0; i < d.length; i += every) profile.push([Math.round(d[i]!), Math.round(e[i]! * 10) / 10]);
  if (d.length && profile[profile.length - 1]![0] !== Math.round(distance)) profile.push([Math.round(distance), Math.round(e[e.length - 1]! * 10) / 10]);
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    distance: Math.round(distance), gain: Math.round(gain), loss: Math.round(loss),
    minEle: known ? Math.round(Math.min(...e)) : null, maxEle: known ? Math.round(Math.max(...e)) : null,
    maxUp: round(maxUp), maxDown: round(maxDown), steepUp, steepDown, profile,
  };
}

/** How hard a route is, from its paths, climbing, length and steepest parts. */
export function rate(s: RouteStats, kinds: Partial<Record<RoadKind, number>>, level: number | null): Rating {
  let points = 0;
  const reasons: string[] = [];
  const km = s.distance / 1000 || 1;
  const trail = (kinds.trail ?? 0) / (s.distance || 1);
  if (trail >= 0.5) {
    points += 1;
    reasons.push(`${Math.round(trail * 100)}% trails and paths`);
  }
  if (level !== null && level >= 2) {
    points += level >= 4 ? 3 : level >= 3 ? 2 : 1;
    reasons.push(`technical parts (S${level} on the mtb scale)`);
  }
  const perKm = s.gain / km;
  if (perKm >= 20) {
    points += perKm >= 35 ? 2 : 1;
    reasons.push(`${Math.round(perKm)} m of climbing per km`);
  }
  if (s.gain >= 800) points += s.gain >= 1500 ? 2 : 1;
  if (s.distance >= 40_000) {
    points += s.distance >= 70_000 ? 2 : 1;
    reasons.push('long');
  }
  if (s.maxUp >= STEEP) {
    points += s.maxUp >= 20 ? 2 : 1;
    reasons.push(`climbs up to ${Math.round(s.maxUp)}%`);
  }
  if (s.maxDown >= 20) {
    points += s.maxDown >= 28 ? 2 : 1;
    reasons.push(`descents up to ${Math.round(s.maxDown)}%`);
  }
  const lv = points <= 2 ? 1 : points <= 4 ? 2 : points <= 7 ? 3 : 4;
  return { difficulty: (['Easy', 'Moderate', 'Hard', 'Very hard'] as const)[lv - 1]!, level: lv, reasons: reasons.length ? reasons : ['mostly gentle'] };
}

/** Everything about a planned route, with elevation from `ele`. */
export function describe(p: Planned, ele: (lon: number, lat: number) => number, loop: boolean, id: string): PlannedRoute {
  const line = elevated(p.line, ele);
  const stats = statsOfLine(line);
  const rating = rate(stats, p.kinds, p.level);
  const name = `${p.heading[0]!.toUpperCase()}${p.heading.slice(1)} ${loop ? 'loop' : 'route'}, ${(stats.distance / 1000).toFixed(1)} km`;
  return {
    id, name, loop, line,
    stats, rating, fresh: Math.round(p.fresh), repeated: Math.round(p.repeated), ...(p.favorite ? { favorite: Math.round(p.favorite) } : {}), kinds: p.kinds, level: p.level, restricted: p.restricted,
  };
}

// --- units ----------------------------------------------------------------------------

const n = (x: number, digits = 0) => x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** "24.3 km (15.1 mi)" */
export const km = (m: number) => `${n(m / 1000, 1)} km (${n(m / 1609.344, 1)} mi)`;
/** "540 m (1,772 ft)" */
export const height = (m: number) => `${n(m)} m (${n(m * 3.28084)} ft)`;
/** Short forms for tables. */
export const kmShort = (m: number) => `${n(m / 1000, 1)} km / ${n(m / 1609.344, 1)} mi`;
export const heightShort = (m: number) => `${n(m)} m / ${n(m * 3.28084)} ft`;

// --- GPX --------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A GPX track of a route, with elevations where known. */
export function routeGpx(name: string, line: [number, number, number][], created: string): string {
  const pts = line.map(([lon, lat, ele]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${Number.isFinite(ele) ? `<ele>${ele.toFixed(1)}</ele>` : ''}</trkpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trail Explorer" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${created}</time></metadata>
  <trk>
    <name>${esc(name)}</name>
    <type>cycling</type>
    <trkseg>
${pts.join('\n')}
    </trkseg>
  </trk>
</gpx>
`;
}

/** The points of a GPX track, with elevations (NaN where missing). */
export function gpxLine(text: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const m of text.matchAll(/<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g)) {
    const lat = Number(m[1]!.match(/\blat="([^"]+)"/)?.[1]);
    const lon = Number(m[1]!.match(/\blon="([^"]+)"/)?.[1]);
    const ele = Number(m[2]?.match(/<ele>([^<]+)<\/ele>/)?.[1] ?? NaN);
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lon, lat, ele]);
  }
  return out;
}

/** Stats again from a saved route's line, as on the day it was planned. */
export function statsOfLine(line: [number, number, number][]): RouteStats {
  const d: number[] = [0];
  for (let i = 1; i < line.length; i++) d.push(d[i - 1]! + metres(line[i - 1]![0], line[i - 1]![1], line[i]![0], line[i]![1]));
  // Points are uneven, so resample every STEP metres by straight lines between them.
  const rd: number[] = [], re: number[] = [];
  for (let at = 0, i = 0; d.length && at <= d[d.length - 1]!; at += STEP) {
    while (i < d.length - 2 && d[i + 1]! < at) i++;
    const span = d[i + 1]! - d[i]!;
    const t = span ? (at - d[i]!) / span : 0;
    rd.push(at);
    re.push(line[i]![2] + ((line[Math.min(i + 1, line.length - 1)]![2] - line[i]![2]) * Math.max(0, Math.min(1, t))));
  }
  const end = d[d.length - 1] ?? 0;
  if (line.length > 1 && rd[rd.length - 1]! < end) {
    rd.push(end);
    re.push(line[line.length - 1]![2]);
  }
  return statsOf(rd, re);
}
