// Changes the app makes to its config files, worked out the same way whichever
// app makes them: the desktop app writes the result to its config folder, the web
// app to the browser's store. Each takes what is there now and returns what to
// write, or throws a message for people. No Node, Electron or DOM here.
import type { LayerState } from './api.ts';
import { checkAreaEdit, checkGroupEdit, newAreaId, type Area, type AreaEdit, type AreaGroup, type GroupEdit } from './areas.ts';
import { checkFile, fileText, MAX_WIDTH, MIN_WIDTH, parseConfig, type Config, type FILES, type LayerDef } from './config.ts';
import type { PlannedRoute } from './route.ts';
import { routeGpx } from './route.ts';
import { newRouteId, type SavedRoute } from './routes.ts';
import type { Shape } from './shapes.ts';

type Areas = { areas: Area[]; groups: AreaGroup[] };

/** A circle's radius is kept in whole metres. */
const tidy = (s: Shape): Shape => (s.kind === 'circle' ? { ...s, radius: Math.round(s.radius) } : s);

/** A new area, which takes on what its group shows and hides. Returns its id too. */
export function addArea({ areas, groups }: Areas, a: { shape?: unknown; name?: unknown; group?: unknown }): Areas & { id: string } {
  const edit = { shape: a?.shape, name: typeof a?.name === 'string' && a.name.trim() ? a.name.trim() : null, group: a?.group ?? null } as AreaEdit;
  if (edit.shape === undefined) throw new Error('An area needs a place and a size.');
  checkAreaEdit(edit);
  if (edit.group && !groups.some((g) => g.id === edit.group)) throw new Error('That group is no longer in areas.json.');
  const id = newAreaId([...areas, ...groups]);
  const like = areas.find((x) => x.group && x.group === edit.group);
  const area: Area = { id, name: edit.name ?? null, shape: tidy(edit.shape!), on: like?.on ?? true, hide: like ? [...like.hide] : [], group: edit.group ?? null };
  return { areas: [...areas, area], groups, id };
}

export function editArea({ areas, groups }: Areas, id: unknown, e: unknown): Areas {
  const edit = (e ?? {}) as AreaEdit;
  checkAreaEdit(edit);
  const clean: AreaEdit = {};
  if (edit.name !== undefined) clean.name = edit.name?.trim() || null;
  if (edit.on !== undefined) clean.on = edit.on;
  if (edit.hide !== undefined) clean.hide = [...new Set(edit.hide)];
  if (edit.shape !== undefined) clean.shape = tidy(edit.shape);
  if (edit.group !== undefined) clean.group = edit.group;
  if (!areas.some((a) => a.id === id)) throw new Error('That area is no longer in areas.json.');
  if (clean.group && !groups.some((g) => g.id === clean.group)) throw new Error('That group is no longer in areas.json.');
  return { areas: areas.map((a) => (a.id === id ? { ...a, ...clean } : a)), groups };
}

export function removeArea({ areas, groups }: Areas, id: unknown): Areas {
  if (!areas.some((a) => a.id === id)) throw new Error('That area is no longer in areas.json.');
  return { areas: areas.filter((a) => a.id !== id), groups };
}

/** A new group of these areas, taking them out of any other. Returns its id too. */
export function addGroup({ areas, groups }: Areas, name: unknown, ids: unknown): Areas & { id: string } {
  checkGroupEdit({ name: name as string });
  if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string')) throw new Error('Choose at least one area for the group.');
  if (!ids.every((x) => areas.some((a) => a.id === x))) throw new Error('One of those areas is no longer in areas.json.');
  const id = newAreaId([...areas, ...groups], Math.random, 'g-');
  return { areas: areas.map((a) => (ids.includes(a.id) ? { ...a, group: id } : a)), groups: [...groups, { id, name: (name as string).trim(), joined: false }], id };
}

export function editGroup({ areas, groups }: Areas, id: unknown, e: unknown): Areas {
  const edit = (e ?? {}) as GroupEdit;
  checkGroupEdit(edit);
  const clean: GroupEdit = {};
  if (edit.name !== undefined) clean.name = edit.name.trim();
  if (edit.joined !== undefined) clean.joined = edit.joined;
  if (!groups.some((g) => g.id === id)) throw new Error('That group is no longer in areas.json.');
  return { areas, groups: groups.map((g) => (g.id === id ? { ...g, ...clean } : g)) };
}

/** Removes a group. Its areas stay, on their own, unless `withAreas`. */
export function removeGroup({ areas, groups }: Areas, id: unknown, withAreas: unknown): Areas {
  if (!groups.some((g) => g.id === id)) throw new Error('That group is no longer in areas.json.');
  const left = withAreas === true ? areas.filter((a) => a.group !== id) : areas.map((a) => (a.group === id ? { ...a, group: null } : a));
  return { areas: left, groups: groups.filter((g) => g.id !== id) };
}

/** The text to write for one config file changed in Customize. Refused, with the reasons, when anything in it is wrong. */
export function configFileText(file: (typeof FILES)[number], value: unknown, config: Config, before: string | undefined): string {
  const bad = checkFile(file, value);
  if (bad.length) throw new Error(bad.map((p) => p.message).join(' '));
  // Read back the same way a hand-edited file would be, so both end up alike.
  const next = parseConfig({ [file]: JSON.stringify(value) }).config;
  return fileText(file, { ...config, map: next.map, heatmap: next.heatmap, layers: file === 'layers.json' ? next.layers : config.layers }, before);
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length < 100;

/** The layers with the order, visibility, opacity and line width set in the sidebar, top first. */
export function layersFromState(layers: LayerDef[], ls: unknown): LayerDef[] {
  if (!Array.isArray(ls) || ls.length > 500) throw new Error('Unknown layers.');
  const state = new Map<string, LayerState>();
  for (const l of ls) if (isId(l?.id) && typeof l.on === 'boolean' && Number.isFinite(l.opacity)) state.set(l.id, l);
  const order = [...state.keys()];
  const rank = (l: LayerDef) => (state.has(l.id) ? order.indexOf(l.id) : order.length);
  return layers
    .map((l) => {
      const st = state.get(l.id);
      if (!st) return l;
      const next = { ...l, on: st.on, opacity: Math.max(0.05, Math.min(1, Math.round(st.opacity * 100) / 100)) };
      if ((next.type !== 'heatmap' && next.type !== 'roads') || st.width === undefined || !Number.isFinite(st.width)) return next;
      const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(st.width * 100) / 100));
      return width === 1 ? { ...next, width: undefined } : { ...next, width };
    })
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i)
    .map((x) => x.l);
}

/** A planned route saved under a name: its entry in routes.json, and its GPX file. */
export function savedRoute(list: SavedRoute[], p: PlannedRoute, name: unknown): { route: SavedRoute; gpx: string } {
  const clean = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : p.name;
  const created = new Date().toISOString();
  const route: SavedRoute = {
    id: newRouteId(new Set(list.map((r) => r.id))), name: clean, created, loop: p.loop, start: [p.line[0]![0], p.line[0]![1]],
    distance: p.stats.distance, gain: p.stats.gain, loss: p.stats.loss, maxUp: p.stats.maxUp, maxDown: p.stats.maxDown,
    difficulty: p.rating.difficulty, fresh: p.fresh,
  };
  return { route, gpx: routeGpx(clean, p.line, created) };
}

/** A file name for downloading a route's GPX. */
export const gpxName = (name: string) => `${name.replace(/[^\w .,()-]+/g, '_').slice(0, 80) || 'route'}.gpx`;
