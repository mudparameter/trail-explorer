// Areas: circles and rectangles drawn on the map to find roads and trails in. The
// list lives in areas.json in the config folder. The road data itself is shared
// between areas and kept by the app, so overlapping areas never store or download it twice.
//
// Shapes can be put in a group, since one place often takes several to cover. A
// group is either separate (a folder of shapes, each still its own area) or joined
// (one area: one outline around all its shapes, and one list of roads).
import { prettyJson } from './config.ts';
import { KINDS, type RoadKind } from './roads.ts';
import { MAX_AREA, MIN_AREA, rectSize, MAX_SIDE, MIN_SIDE, shapeProblem, type Shape } from './shapes.ts';

export const AREAS_FILE = 'areas.json';

export interface Area {
  /** Short and stable, so the app can change one area in the file. */
  id: string;
  /** Optional. */
  name: string | null;
  shape: Shape;
  /** Shown on the map. */
  on: boolean;
  /** Kinds of road left off the map for this area. */
  hide: RoadKind[];
  /** The group it is in, if any. */
  group: string | null;
}
export type AreaEdit = Partial<Pick<Area, 'name' | 'on' | 'hide' | 'shape' | 'group'>>;

export interface AreaGroup {
  /** Shares the id space with areas, so a road's key says which one it belongs to. */
  id: string;
  name: string;
  /** Shown as one area. Otherwise its shapes stay separate areas, listed under it. */
  joined: boolean;
}
export type GroupEdit = Partial<Pick<AreaGroup, 'name' | 'joined'>>;

const isNums = (p: unknown, n: number): p is number[] => Array.isArray(p) && p.length === n && p.every((v) => typeof v === 'number' && Number.isFinite(v));
const isPos = (p: unknown): p is [number, number] => isNums(p, 2) && Math.abs(p[0]!) <= 180 && Math.abs(p[1]!) <= 85;
const isBox = (b: unknown): b is [number, number, number, number] =>
  isNums(b, 4) && isPos([b[0], b[1]]) && isPos([b[2], b[3]]) && b[0]! < b[2]! && b[1]! < b[3]!;

/** A shape that is well formed, whatever its size. */
function isShape(s: unknown): s is Shape {
  const v = s as Shape | null;
  if (v?.kind === 'circle') return isPos(v.center) && typeof v.radius === 'number' && Number.isFinite(v.radius);
  if (v?.kind === 'rect') return isBox(v.box);
  return false;
}
const KIND_IDS = KINDS.map((k) => k.kind);
const ID = /^[a-z0-9-]{1,40}$/;

/** Reads areas.json. Problems are about areas or fields that were left out or replaced. */
export function parseAreas(text: string): { areas: Area[]; groups: AreaGroup[]; problems: string[] } {
  const problems: string[] = [];
  let v: any;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { areas: [], groups: [], problems: [`Not valid JSON: ${e instanceof Error ? e.message : e}`] };
  }
  if (!Array.isArray(v?.areas)) return { areas: [], groups: [], problems: ['Should be { "areas": [ … ] }.'] };
  const groups: AreaGroup[] = [];
  if (Array.isArray(v.groups)) {
    v.groups.forEach((g: any, i: number) => {
      const at = `Group ${i + 1}`;
      if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !ID.test(g.id)) {
        return problems.push(`${at} should be { "id": "…", "name": "…" }, with an id of up to 40 lowercase letters, digits and dashes. It is left out.`);
      }
      if (groups.some((x) => x.id === g.id)) return problems.push(`${at}: another group has the id "${g.id}". It is left out.`);
      const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim().slice(0, 100) : 'Group';
      if (name === 'Group' && g.name !== undefined && !(typeof g.name === 'string' && g.name.trim())) problems.push(`${at}: "name" should be text.`);
      let joined = false;
      if (typeof g.joined === 'boolean') joined = g.joined;
      else if (g.joined !== undefined) problems.push(`${at}: "joined" should be true or false.`);
      groups.push({ id: g.id, name, joined });
    });
  } else if (v.groups !== undefined) problems.push('"groups" should be a list. Every area is shown on its own.');
  const areas: Area[] = [];
  v.areas.forEach((a: any, i: number) => {
    const at = `Area ${i + 1}`;
    if (!a || typeof a !== 'object') return problems.push(`${at} should be { "center": [lon, lat], "radius": 1000 } or { "box": [west, south, east, north] }. It is left out.`);
    let shape: Shape;
    // Areas added by hand may leave out the id. One made from the shape stays the same between reads.
    let made: string;
    if (a.box !== undefined) {
      if (!isBox(a.box)) return problems.push(`${at}: "box" should be [west, south, east, north], in degrees. It is left out.`);
      shape = { kind: 'rect', box: [a.box[0], a.box[1], a.box[2], a.box[3]] };
      const [w, h] = rectSize(shape.box);
      // A metre either way, for rounding.
      if (Math.min(w, h) < MIN_SIDE - 1 || Math.max(w, h) > MAX_SIDE + 1) return problems.push(`${at}: "box" sides should be ${MIN_SIDE} to ${MAX_SIDE} metres. It is left out.`);
      made = `r${a.box.map((x: number) => x.toFixed(4)).join('_')}`;
    } else {
      if (!isPos(a.center)) return problems.push(`${at}: "center" should be [longitude, latitude]. It is left out.`);
      if (!(typeof a.radius === 'number' && a.radius >= MIN_AREA && a.radius <= MAX_AREA)) {
        return problems.push(`${at}: "radius" should be ${MIN_AREA} to ${MAX_AREA} metres. It is left out.`);
      }
      shape = { kind: 'circle', center: [a.center[0], a.center[1]], radius: Math.round(a.radius) };
      made = `c${a.center[0].toFixed(5)}_${a.center[1].toFixed(5)}_${Math.round(a.radius)}`;
    }
    let id = typeof a.id === 'string' && ID.test(a.id) ? a.id : made.replace(/[^a-z0-9-]/g, '-');
    if (a.id !== undefined && id !== a.id) problems.push(`${at}: "id" should be up to 40 lowercase letters, digits and dashes. Using ${id}.`);
    if (areas.some((x) => x.id === id) || groups.some((g) => g.id === id)) return problems.push(`${at}: another area or group has the id "${id}". It is left out.`);
    let name: string | null = null;
    if (typeof a.name === 'string' && a.name.trim()) name = a.name.trim().slice(0, 100);
    else if (a.name !== undefined && a.name !== null && a.name !== '') problems.push(`${at}: "name" should be text.`);
    let on = true;
    if (typeof a.on === 'boolean') on = a.on;
    else if (a.on !== undefined) problems.push(`${at}: "on" should be true or false.`);
    let hide: RoadKind[] = [];
    if (Array.isArray(a.hide) && a.hide.every((k: unknown) => KIND_IDS.includes(k as RoadKind))) hide = [...new Set(a.hide as RoadKind[])];
    else if (a.hide !== undefined) problems.push(`${at}: "hide" should be a list of ${KIND_IDS.map((k) => `"${k}"`).join(', ')}.`);
    let group: string | null = null;
    if (typeof a.group === 'string' && groups.some((g) => g.id === a.group)) group = a.group;
    else if (a.group !== undefined && a.group !== null) problems.push(`${at}: "group" should be the id of one of the "groups". It is shown on its own.`);
    areas.push({ id, name, shape, on, hide, group });
  });
  return { areas, groups, problems };
}

/** Checks an edit before it is written. */
export function checkAreaEdit(e: AreaEdit) {
  if (e.shape !== undefined) {
    if (!isShape(e.shape)) throw new Error('An area needs a place on the map.');
    const bad = shapeProblem(e.shape);
    if (bad) throw new Error(bad);
  }
  if (e.name !== undefined && e.name !== null && (typeof e.name !== 'string' || e.name.length > 100)) throw new Error('A name can be up to 100 characters.');
  if (e.on !== undefined && typeof e.on !== 'boolean') throw new Error('Unknown setting.');
  if (e.hide !== undefined && !(Array.isArray(e.hide) && e.hide.every((k) => KIND_IDS.includes(k)))) throw new Error('Unknown kind of road.');
  if (e.group !== undefined && e.group !== null && !(typeof e.group === 'string' && ID.test(e.group))) throw new Error('Unknown group.');
}

/** Checks a group edit before it is written. */
export function checkGroupEdit(e: GroupEdit) {
  if (e.name !== undefined && (typeof e.name !== 'string' || !e.name.trim() || e.name.length > 100)) throw new Error('A group needs a name of up to 100 characters.');
  if (e.joined !== undefined && typeof e.joined !== 'boolean') throw new Error('Unknown setting.');
}

/** A new id not used by any area or group. Groups' ids start with g-, so they are easy to tell apart in the file. */
export function newAreaId(areas: { id: string }[], random = Math.random, prefix = ''): string {
  for (;;) {
    const id = prefix + Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');
    if (!areas.some((a) => a.id === id)) return id;
  }
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** areas.json for these areas and groups, keeping // comments from `before`. One per line. Groups with no areas are dropped. */
export function areasText(areas: Area[], groups: AreaGroup[] = [], before?: string): string {
  let comments: Record<string, unknown> = {};
  try {
    const v = before ? JSON.parse(before) : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) comments = Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith('//')));
  } catch {}
  if (!Object.keys(comments).length) {
    comments['//'] = NOTE;
  }
  const used = groups.filter((g) => areas.some((a) => a.group === g.id));
  const list = areas.map((a) => ({
    id: a.id, ...(a.name ? { name: a.name } : {}),
    ...(a.shape.kind === 'rect' ? { box: a.shape.box.map(round) } : { center: a.shape.center.map(round), radius: Math.round(a.shape.radius) }),
    on: a.on, hide: a.hide,
    ...(a.group && used.some((g) => g.id === a.group) ? { group: a.group } : {}),
  }));
  const head = prettyJson(comments).trimEnd().slice(0, -1).trimEnd();
  const lines = (xs: unknown[]) => (xs.length ? `[\n${xs.map((a) => '    ' + prettyJson(a).trim().replace(/\n\s*/g, ' ')).join(',\n')}\n  ]` : '[]');
  const g = used.length ? `,\n  "groups": ${lines(used.map((x) => ({ id: x.id, name: x.name, joined: x.joined })))}` : '';
  return `${head}${g},\n  "areas": ${lines(list)}\n}\n`;
}

const NOTE = 'Circles and rectangles to find roads and trails in. Draw them on the map, or add { "center": [lon, lat], "radius": metres } or { "box": [west, south, east, north] }. "name", "on", "hide" and "group" are optional. See README.md.';
