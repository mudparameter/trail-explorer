// Saved routes: a list in routes.json in the config folder, and a GPX file per
// route in routes/. No Electron or DOM code here.
import type { Difficulty } from './route.ts';

export const ROUTES_FILE = 'routes.json';
export const routeFile = (id: string) => `routes/${id}.gpx`;
export const isRouteId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9]{4,24}$/.test(id);

export interface SavedRoute {
  id: string;
  name: string;
  /** ISO time it was saved. */
  created: string;
  loop: boolean;
  start: [number, number];
  /** Metres. */
  distance: number;
  gain: number;
  loss: number;
  /** Steepest climb and descent, %. */
  maxUp: number;
  maxDown: number;
  difficulty: Difficulty;
  /** Metres of trail not yet ridden when it was planned. */
  fresh: number;
}

const DIFFICULTIES: Difficulty[] = ['Easy', 'Moderate', 'Hard', 'Very hard'];
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Reads routes.json. Entries that don't make sense are left out. */
export function parseRoutes(text: string | undefined): SavedRoute[] {
  if (!text) return [];
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return [];
  }
  const out: SavedRoute[] = [];
  const ids = new Set<string>();
  for (const r of Array.isArray(o?.routes) ? o.routes : []) {
    if (!r || !isRouteId(r.id) || ids.has(r.id)) continue;
    const start = Array.isArray(r.start) && r.start.length === 2 && r.start.every((x: unknown) => num(x) !== null) ? (r.start as [number, number]) : null;
    const distance = num(r.distance);
    if (!start || distance === null) continue;
    ids.add(r.id);
    out.push({
      id: r.id,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 100) : 'Route',
      created: typeof r.created === 'string' && !Number.isNaN(Date.parse(r.created)) ? r.created : new Date(0).toISOString(),
      loop: r.loop === true,
      start,
      distance,
      gain: num(r.gain) ?? 0,
      loss: num(r.loss) ?? 0,
      maxUp: num(r.maxUp) ?? 0,
      maxDown: num(r.maxDown) ?? 0,
      difficulty: DIFFICULTIES.includes(r.difficulty) ? r.difficulty : 'Moderate',
      fresh: num(r.fresh) ?? 0,
    });
  }
  return out;
}

/** routes.json, one route per line, keeping any // comments. */
export function routesText(routes: SavedRoute[], before?: string): string {
  let comments: Record<string, unknown> = { '//': 'Routes saved from the route planner. Each has a GPX file in routes/. Rename them in the app or here.' };
  try {
    const o = before ? JSON.parse(before) : null;
    const c = o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith('//'))) : {};
    if (Object.keys(c).length) comments = c;
  } catch {}
  const head = Object.entries(comments).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const lines = routes.map((r) => `    ${JSON.stringify(r)}`);
  return `{\n${head.join('\n')}\n  "routes": [${lines.length ? `\n${lines.join(',\n')}\n  ` : ''}]\n}\n`;
}

/** A short id not used yet. */
export function newRouteId(taken: Set<string>, random = Math.random): string {
  for (;;) {
    const id = Array.from({ length: 8 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)]).join('');
    if (!taken.has(id)) return id;
  }
}
