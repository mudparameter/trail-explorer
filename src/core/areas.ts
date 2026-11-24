// Areas: circles drawn on the map to find roads and trails in. The list lives in
// areas.json in the config folder. The road data itself is shared between areas
// and kept by the app, so overlapping areas never store or download it twice.
//
// Circles can be put in a group, since one place often takes several circles to
// cover. A group is either separate (a folder of circles, each still its own area)
// or joined (one area: one outline around all its circles, and one list of roads).
import { prettyJson } from './config.ts';
import { KINDS, MAX_AREA, MIN_AREA, type RoadKind } from './roads.ts';
import { M_PER_DEG } from './track.ts';
import { circleRing } from './zones.ts';

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
  /** The group it is in, if any. */
  group: string | null;
}
export type AreaEdit = Partial<Pick<Area, 'name' | 'on' | 'hide' | 'center' | 'radius' | 'group'>>;

export interface AreaGroup {
  /** Shares the id space with areas, so a road's key says which one it belongs to. */
  id: string;
  name: string;
  /** Shown as one area. Otherwise its circles stay separate areas, listed under it. */
  joined: boolean;
}
export type GroupEdit = Partial<Pick<AreaGroup, 'name' | 'joined'>>;

const isPos = (p: unknown): p is [number, number] =>
  Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85;
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
  } else if (v.groups !== undefined) problems.push('"groups" should be a list. Every circle is shown on its own.');
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
    areas.push({ id, name, center: [a.center[0], a.center[1]], radius: Math.round(a.radius), on, hide, group });
  });
  return { areas, groups, problems };
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

/** areas.json for these areas and groups, keeping // comments from `before`. One per line. Groups with no circles are dropped. */
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
    id: a.id, ...(a.name ? { name: a.name } : {}), center: [round(a.center[0]), round(a.center[1])], radius: Math.round(a.radius), on: a.on, hide: a.hide,
    ...(a.group && used.some((g) => g.id === a.group) ? { group: a.group } : {}),
  }));
  const head = prettyJson(comments).trimEnd().slice(0, -1).trimEnd();
  const lines = (xs: unknown[]) => (xs.length ? `[\n${xs.map((a) => '    ' + prettyJson(a).trim().replace(/\n\s*/g, ' ')).join(',\n')}\n  ]` : '[]');
  const g = used.length ? `,\n  "groups": ${lines(used.map((x) => ({ id: x.id, name: x.name, joined: x.joined })))}` : '';
  return `${head}${g},\n  "areas": ${lines(list)}\n}\n`;
}

const NOTE = 'Circles to find roads and trails in. Draw them on the map, or add { "center": [lon, lat], "radius": metres }. "name", "on", "hide" and "group" are optional. See README.md.';

export interface Circle {
  center: [number, number];
  radius: number;
}

/**
 * The outline around overlapping circles: each circle's edge, less the parts
 * inside another circle. Lines for drawing; a lone circle gives its whole ring.
 */
export function unionEdge(circles: Circle[], steps = 120): [number, number][][] {
  const ks = circles.map((c) => Math.cos((c.center[1] * Math.PI) / 180) * M_PER_DEG);
  const inside = (p: [number, number], skip: number) => circles.some((c, j) =>
    j !== skip && Math.hypot((p[0] - c.center[0]) * ks[j]!, (p[1] - c.center[1]) * M_PER_DEG) < c.radius);
  const out: [number, number][][] = [];
  circles.forEach((c, i) => {
    const k = Math.max(ks[i]!, 1);
    const at = (a: number): [number, number] => [c.center[0] + (c.radius * Math.cos(a)) / k, c.center[1] + (c.radius * Math.sin(a)) / M_PER_DEG];
    const angle = (n: number) => (n / steps) * 2 * Math.PI;
    const keep = Array.from({ length: steps }, (_, n) => !inside(at(angle(n)), i));
    if (keep.every(Boolean)) return out.push(circleRing(c.center, c.radius, steps));
    if (!keep.some(Boolean)) return;
    /** Where the edge crosses into or out of another circle, between two steps. */
    const cross = (a: number, b: number, inAtA: boolean): [number, number] => {
      for (let n = 0; n < 20; n++) {
        const m = (a + b) / 2;
        if (inside(at(m), i) === inAtA) a = m;
        else b = m;
      }
      return at((a + b) / 2);
    };
    // Start just after a step that is cut, so every kept run is whole.
    const start = keep.indexOf(false);
    let run: [number, number][] = [];
    for (let n = start + 1; n <= start + steps; n++) {
      const cur = n % steps;
      const prev = (n - 1) % steps;
      if (keep[cur]) {
        if (!keep[prev]) run.push(cross(angle(n - 1), angle(n), true));
        run.push(at(angle(n)));
      } else if (keep[prev]) {
        run.push(cross(angle(n - 1), angle(n), false));
        out.push(run);
        run = [];
      }
    }
  });
  return out;
}
