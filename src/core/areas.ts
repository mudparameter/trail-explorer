// Areas: circles drawn on the map to find roads and trails in. The list lives in
// areas.json in the config folder. The road data itself is shared between areas
// and kept by the app, so overlapping areas never store or download it twice.
import { prettyJson } from './config.ts';
import { KINDS, MAX_AREA, MIN_AREA, type RoadKind } from './roads.ts';

export const AREAS_FILE = 'areas.json';

export interface Area {
  /** Short and stable, so the app can change one area in the file. */
  id: string;
  /** Optional. */
  name: string | null;
  center: [number, number];
  radius: number;
  /** Shown on the map. */
  on: boolean;
  /** Kinds of road left off the map for this area. */
  hide: RoadKind[];
}
export type AreaEdit = Partial<Pick<Area, 'name' | 'on' | 'hide' | 'center' | 'radius'>>;

const isPos = (p: unknown): p is [number, number] =>
  Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85;
const KIND_IDS = KINDS.map((k) => k.kind);
const ID = /^[a-z0-9-]{1,40}$/;

/** Reads areas.json. Problems are about areas or fields that were left out or replaced. */
export function parseAreas(text: string): { areas: Area[]; problems: string[] } {
  const problems: string[] = [];
  let v: any;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { areas: [], problems: [`Not valid JSON: ${e instanceof Error ? e.message : e}`] };
  }
  if (!Array.isArray(v?.areas)) return { areas: [], problems: ['Should be { "areas": [ … ] }.'] };
  const areas: Area[] = [];
  v.areas.forEach((a: any, i: number) => {
    const at = `Area ${i + 1}`;
    if (!a || typeof a !== 'object') return problems.push(`${at} should be { "center": [lon, lat], "radius": 1000 }. It is left out.`);
    if (!isPos(a.center)) return problems.push(`${at}: "center" should be [longitude, latitude]. It is left out.`);
    if (!(typeof a.radius === 'number' && a.radius >= MIN_AREA && a.radius <= MAX_AREA)) {
      return problems.push(`${at}: "radius" should be ${MIN_AREA} to ${MAX_AREA} metres. It is left out.`);
    }
    // Areas added by hand may leave out the id. One made from the circle stays the same between reads.
    let id = typeof a.id === 'string' && ID.test(a.id) ? a.id : `c${a.center[0].toFixed(5)}_${a.center[1].toFixed(5)}_${Math.round(a.radius)}`.replace(/[^a-z0-9-]/g, '-');
    if (a.id !== undefined && id !== a.id) problems.push(`${at}: "id" should be up to 40 lowercase letters, digits and dashes. Using ${id}.`);
    if (areas.some((x) => x.id === id)) return problems.push(`${at}: another area has the id "${id}". It is left out.`);
    let name: string | null = null;
    if (typeof a.name === 'string' && a.name.trim()) name = a.name.trim().slice(0, 100);
    else if (a.name !== undefined && a.name !== null && a.name !== '') problems.push(`${at}: "name" should be text.`);
    let on = true;
    if (typeof a.on === 'boolean') on = a.on;
    else if (a.on !== undefined) problems.push(`${at}: "on" should be true or false.`);
    let hide: RoadKind[] = [];
    if (Array.isArray(a.hide) && a.hide.every((k: unknown) => KIND_IDS.includes(k as RoadKind))) hide = [...new Set(a.hide as RoadKind[])];
    else if (a.hide !== undefined) problems.push(`${at}: "hide" should be a list of ${KIND_IDS.map((k) => `"${k}"`).join(', ')}.`);
    areas.push({ id, name, center: [a.center[0], a.center[1]], radius: Math.round(a.radius), on, hide });
  });
  return { areas, problems };
}

/** Checks an edit before it is written. */
export function checkAreaEdit(e: AreaEdit) {
  if (e.center !== undefined && !isPos(e.center)) throw new Error('An area needs a place on the map.');
  if (e.radius !== undefined && !(typeof e.radius === 'number' && e.radius >= MIN_AREA && e.radius <= MAX_AREA)) {
    throw new Error(`An area's radius should be ${MIN_AREA} m to ${MAX_AREA / 1000} km.`);
  }
  if (e.name !== undefined && e.name !== null && (typeof e.name !== 'string' || e.name.length > 100)) throw new Error('A name can be up to 100 characters.');
  if (e.on !== undefined && typeof e.on !== 'boolean') throw new Error('Unknown setting.');
  if (e.hide !== undefined && !(Array.isArray(e.hide) && e.hide.every((k) => KIND_IDS.includes(k)))) throw new Error('Unknown kind of road.');
}

/** A new id not used by any of `areas`. */
export function newAreaId(areas: Area[], random = Math.random): string {
  for (;;) {
    const id = Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');
    if (!areas.some((a) => a.id === id)) return id;
  }
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** areas.json for these areas, keeping // comments from `before`. One area per line. */
export function areasText(areas: Area[], before?: string): string {
  let comments: Record<string, unknown> = {};
  try {
    const v = before ? JSON.parse(before) : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) comments = Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith('//')));
  } catch {}
  if (!Object.keys(comments).length) {
    comments['//'] = 'Circles to find roads and trails in. Draw them on the map, or add { "center": [lon, lat], "radius": metres }. "name", "on" and "hide" are optional. See README.md.';
  }
  const list = areas.map((a) => ({
    id: a.id, ...(a.name ? { name: a.name } : {}), center: [round(a.center[0]), round(a.center[1])], radius: Math.round(a.radius), on: a.on, hide: a.hide,
  }));
  const head = prettyJson(comments).trimEnd().slice(0, -1).trimEnd();
  const body = list.length ? `[\n${list.map((a) => '    ' + prettyJson(a).trim().replace(/\n\s*/g, ' ')).join(',\n')}\n  ]` : '[]';
  return `${head},\n  "areas": ${body}\n}\n`;
}
