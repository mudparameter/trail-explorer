// The config folder: everything about how the map looks, in plain JSON files
// that work the same on every system and on the web. No Node, Electron or DOM here,
// so any host can read the files its own way and pass the text in.
//
//   map.json        start view, zoom limits, background
//   heatmap.json    colour bands and how rides are matched
//   layers.json     every layer, top first
//   maps/           offline map files named in layers.json
//   zones/*.geojson places left out of the heatmap
//   areas.json      circles to find roads and trails in
//
// Every file and every field is optional. A bad value is reported and replaced
// by its default, so one typo never stops the app.
import { ACTIVITY_IDS, type Activity } from './activities.ts';
import type { Bounds, View } from './api.ts';
import { AREAS_FILE, parseAreas, type Area } from './areas.ts';
import { DEFAULT_OVERPASS } from './roads.ts';
import { parseZones, type Zone } from './zones.ts';

export interface Band {
  /** Lowest number of passes in this band. */
  from: number;
  color: string;
  /** Legend text. Made from the numbers when left out. */
  label?: string;
}
interface LayerBase {
  id: string;
  name: string;
  /** Small text after the name, such as who made the map. */
  note?: string;
  on: boolean;
  opacity: number;
}
export type LayerDef =
  /** `width` scales how thick ride lines are; left out means 1. */
  | (LayerBase & { type: 'heatmap'; width?: number })
  /** The roads and trails found in drawn circles, all circles together. */
  | (LayerBase & { type: 'roads'; width?: number })
  | (LayerBase & { type: 'openfreemap' })
  | (LayerBase & { type: 'raster'; tiles: string[]; tileSize: number; minzoom: number; maxzoom: number; bounds?: Bounds; attribution: string })
  | (LayerBase & { type: 'file'; file: string });
export type LayerType = LayerDef['type'];

export interface MapConfig {
  /** Where the map opens. Null fits the map to your rides. */
  view: View | null;
  minZoom: number;
  maxZoom: number;
  background: string;
  /** Overpass API servers that road and trail searches ask for OpenStreetMap data, tried in order. */
  overpass: string[];
}
export interface HeatmapConfig {
  bands: Band[];
  outline: string;
  /** Kinds of activity left off the heatmap. */
  hide: Activity[];
  /** Metres within which a ride counts as on an existing section. */
  radius: number;
  /** Largest difference in direction, in degrees, for a ride to join a section. */
  angle: number;
  /** Length of the pieces new sections are made of, in metres. */
  step: number;
}
export interface Config {
  map: MapConfig;
  heatmap: HeatmapConfig;
  /** Top first. Always has exactly one heatmap layer. */
  layers: LayerDef[];
  zones: Zone[];
  areas: Area[];
}
export interface Problem {
  file: string;
  message: string;
}

export const HEATMAP_ID = 'heatmap';
export const ROADS_ID = 'roads';
const ROADS_LAYER = { id: ROADS_ID, type: 'roads', name: 'Roads and trails', on: true, opacity: 1 } as const;
/** The zones file the app edits. Others in zones/ are read but left alone. */
export const APP_ZONES = 'zones/zones.geojson';
export const FILES = ['map.json', 'heatmap.json', 'layers.json'] as const;

const OSM = '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>';

export const DEFAULTS: Config = {
  map: { view: null, minZoom: 0, maxZoom: 19, background: '#eeeeee', overpass: DEFAULT_OVERPASS },
  heatmap: {
    bands: [
      { from: 1, color: '#2f6bff' },
      { from: 2, color: '#8a3ffc' },
      { from: 4, color: '#e0369a' },
      { from: 8, color: '#f0282d' },
      { from: 16, color: '#ffe14d' },
      { from: 40, color: '#ffffff' },
    ],
    outline: '#14141e',
    hide: [],
    radius: 15,
    angle: 35,
    step: 10,
  },
  layers: [
    { id: HEATMAP_ID, type: 'heatmap', name: 'My rides', on: true, opacity: 1 },
    { ...ROADS_LAYER },
    {
      id: 'ign', type: 'raster', name: 'Spain topo', note: 'IGN', on: false, opacity: 1,
      tiles: ['https://www.ign.es/wmts/mapa-raster?layer=MTN&style=default&tilematrixset=GoogleMapsCompatible&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/jpeg&TileMatrix={z}&TileCol={x}&TileRow={y}'],
      tileSize: 256, minzoom: 5, maxzoom: 18, bounds: [-19, 27, 5.5, 44.5],
      attribution: '<a href="https://www.ign.es" target="_blank">CC BY 4.0 ign.es</a>',
    },
    {
      id: 'opentopomap', type: 'raster', name: 'World topo', note: 'OpenTopoMap', on: false, opacity: 1,
      tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
      tileSize: 256, minzoom: 0, maxzoom: 17,
      attribution: `${OSM}, SRTM | <a href="https://opentopomap.org" target="_blank">© OpenTopoMap</a> (CC-BY-SA)`,
    },
    { id: 'openfreemap', type: 'openfreemap', name: 'World map', note: 'OpenFreeMap', on: true, opacity: 1 },
  ],
  zones: [],
  areas: [],
};

/** Legend text for each band: "1", "2 to 3", "40 or more". */
export function bandLabels(bands: Band[]): string[] {
  return bands.map((b, i) => {
    if (b.label) return b.label;
    const next = bands[i + 1]?.from;
    if (next === undefined) return `${b.from} or more`;
    return next - 1 === b.from ? String(b.from) : `${b.from} to ${next - 1}`;
  });
}

/** Web addresses a config's layers load from, for a Content-Security-Policy. */
export function mapOrigins(layers: LayerDef[]): string[] {
  const out = new Set<string>();
  for (const l of layers) {
    if (l.type === 'openfreemap') out.add('https://tiles.openfreemap.org');
    if (l.type === 'raster') for (const t of l.tiles) out.add(new URL(t).origin);
  }
  return [...out].sort();
}

// --- reading --------------------------------------------------------------------

/** Reads a config from file contents keyed by path inside the folder (`map.json`, `zones/home.geojson`). */
export function parseConfig(files: Record<string, string>): { config: Config; problems: Problem[] } {
  const problems: Problem[] = [];
  const json = (file: string): Record<string, unknown> | null => {
    const text = files[file];
    if (text === undefined) return null;
    try {
      const v = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      problems.push({ file, message: 'The file should hold one { … } object.' });
    } catch (e) {
      problems.push({ file, message: `Not valid JSON: ${e instanceof Error ? e.message : e}` });
    }
    return null;
  };
  const zones: Zone[] = [];
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^zones\/[^/]+\.(geo)?json$/i.test(path)) continue;
    const r = parseZones(path, text, path === APP_ZONES);
    zones.push(...r.zones);
    problems.push(...r.problems.map((message) => ({ file: path, message })));
  }
  let areas: Area[] = [];
  if (files[AREAS_FILE] !== undefined) {
    const r = parseAreas(files[AREAS_FILE]);
    areas = r.areas;
    problems.push(...r.problems.map((message) => ({ file: AREAS_FILE, message })));
  }
  return {
    config: {
      map: readMap(json('map.json'), problems),
      heatmap: readHeatmap(json('heatmap.json'), problems),
      layers: readLayers(json('layers.json'), problems),
      zones,
      areas,
    },
    problems,
  };
}

/** Checks one file's new contents without touching anything. Used before the app writes a file. */
export function checkFile(file: (typeof FILES)[number], value: unknown): Problem[] {
  return parseConfig({ [file]: JSON.stringify(value) }).problems;
}

class Bad extends Error {}
const bad = (message: string): never => {
  throw new Bad(message);
};

/** Reads the fields of one JSON object, reporting anything wrong and falling back to defaults. */
class Fields {
  private file: string;
  private obj: Record<string, unknown>;
  private problems: Problem[];
  private where: string;
  constructor(file: string, obj: Record<string, unknown>, problems: Problem[], known: string[], where = '') {
    this.file = file;
    this.obj = obj;
    this.problems = problems;
    this.where = where;
    for (const k of Object.keys(obj)) {
      if (!k.startsWith('//') && !known.includes(k)) this.bad(`"${k}" is not a setting here, so it is ignored.`);
    }
  }
  bad(message: string) {
    this.problems.push({ file: this.file, message: this.where + message });
  }
  has(k: string) {
    return this.obj[k] !== undefined;
  }
  /** The value of `k` passed through `check`, or `fallback` when it is missing or wrong. */
  get<T>(k: string, fallback: T, check: (v: unknown) => T, otherwise = 'Using the default instead.'): T {
    const v = this.obj[k];
    if (v === undefined) return fallback;
    try {
      return check(v);
    } catch (e) {
      if (!(e instanceof Bad)) throw e;
      this.bad(`"${k}" ${e.message} ${otherwise}`);
      return fallback;
    }
  }
}

// Checkers return the value or throw Bad with what is wrong.
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const number = (min: number, max: number) => (v: unknown) => (isNum(v) && v >= min && v <= max ? v : bad(`should be a number from ${min} to ${max}.`));
const integer = (min: number, max: number) => (v: unknown) => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : bad(`should be a whole number from ${min} to ${max}.`));
const color = (v: unknown) => (typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v.toLowerCase() : bad('should be a colour like "#2f6bff".'));
const text = (max: number) => (v: unknown) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : bad(`should be text of up to ${max} characters.`));
const bool = (v: unknown) => (typeof v === 'boolean' ? v : bad('should be true or false.'));
const lonLat = (v: unknown): [number, number] =>
  Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 85
    ? [v[0], v[1]] : bad('should be [longitude, latitude], like [-0.47, 39.7].');
const bounds = (v: unknown): Bounds => {
  const b = v as number[];
  return Array.isArray(v) && v.length === 4 && v.every(isNum) && b[0]! < b[2]! && b[1]! < b[3]! && b[0]! >= -180 && b[2]! <= 180 && b[1]! >= -90 && b[3]! <= 90
    ? (v as Bounds) : bad('should be [west, south, east, north], like [-19, 27, 5.5, 44.5].');
};
const httpsUrl = (v: unknown): string => {
  if (typeof v !== 'string' || v.length > 2000) return bad('should be a web address.');
  try {
    if (new URL(v.trim()).protocol === 'https:') return v.trim();
  } catch {}
  return bad(`has "${v}", which is not a web address starting with https://.`);
};
/** One web address, or a list of 1 to 5. */
const servers = (v: unknown): string[] => {
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || list.length < 1 || list.length > 5) return bad('should be a web address, or a list of 1 to 5.');
  return list.map(httpsUrl);
};
const within = <T>(label: string, check: (v: unknown) => T) => (v: unknown): T => {
  try {
    return check(v);
  } catch (e) {
    throw e instanceof Bad ? new Bad(`${label} ${e.message}`) : e;
  }
};

function readMap(o: Record<string, unknown> | null, problems: Problem[]): MapConfig {
  const d = DEFAULTS.map;
  if (!o) return { ...d };
  const f = new Fields('map.json', o, problems, ['view', 'minZoom', 'maxZoom', 'background', 'overpass']);
  const view = f.get<View | null>('view', d.view, (v) => {
    if (v === null) return null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('should be { "center": [lon, lat], "zoom": 11 } or null.');
    return { center: within('has "center", which', lonLat)((v as any).center), zoom: within('has "zoom", which', number(0, 22))((v as any).zoom) };
  });
  const minZoom = f.get('minZoom', d.minZoom, number(0, 22));
  let maxZoom = f.get('maxZoom', d.maxZoom, number(0, 22));
  if (maxZoom < minZoom) {
    f.bad('"maxZoom" is smaller than "minZoom". Using the default instead.');
    maxZoom = Math.max(minZoom, d.maxZoom);
  }
  return { view, minZoom, maxZoom, background: f.get('background', d.background, color), overpass: f.get('overpass', d.overpass, servers) };
}

function readHeatmap(o: Record<string, unknown> | null, problems: Problem[]): HeatmapConfig {
  const d = DEFAULTS.heatmap;
  if (!o) return { ...d, bands: [...d.bands], hide: [] };
  const f = new Fields('heatmap.json', o, problems, ['bands', 'outline', 'hide', 'radius', 'angle', 'step']);
  const bands = f.get<Band[]>('bands', d.bands, (v) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 12) return bad('should be a list of 1 to 12 bands.');
    const out = v.map((b, i): Band => {
      const at = `item ${i + 1}:`;
      if (!b || typeof b !== 'object' || Array.isArray(b)) return bad(`${at} should be { "from": 1, "color": "#2f6bff" }.`);
      const extra = Object.keys(b).find((k) => !k.startsWith('//') && !['from', 'color', 'label'].includes(k));
      if (extra) bad(`${at} "${extra}" is not a band setting.`);
      const from = within(`${at} "from"`, integer(1, 1_000_000))(b.from);
      const c = within(`${at} "color"`, color)(b.color);
      if (b.label === undefined || b.label === '') return { from, color: c };
      return { from, color: c, label: within(`${at} "label"`, text(40))(b.label) };
    });
    if (out[0]!.from !== 1) bad('should start with a band "from": 1, so every ride gets a colour.');
    for (let i = 1; i < out.length; i++) if (out[i]!.from <= out[i - 1]!.from) bad(`should go up: item ${i + 1} starts at ${out[i]!.from}, which is not above ${out[i - 1]!.from}.`);
    return out;
  });
  return {
    bands,
    outline: f.get('outline', d.outline, color),
    hide: f.get<Activity[]>('hide', [], (v) =>
      Array.isArray(v) && v.every((x) => ACTIVITY_IDS.includes(x)) ? [...new Set(v as Activity[])] : bad(`should be a list of ${ACTIVITY_IDS.map((a) => `"${a}"`).join(', ')}.`)),
    radius: f.get('radius', d.radius, number(3, 100)),
    angle: f.get('angle', d.angle, number(5, 90)),
    step: f.get('step', d.step, number(2, 50)),
  };
}

/** How thin or thick ride lines can be, against the usual width. */
export const MIN_WIDTH = 0.25;
export const MAX_WIDTH = 3;

/** What the sidebar changes on a layer. */
export function layerState(l: LayerDef): { id: string; on: boolean; opacity: number; width?: number } {
  return l.type === 'heatmap' || l.type === 'roads' ? { id: l.id, on: l.on, opacity: l.opacity, width: l.width ?? 1 } : { id: l.id, on: l.on, opacity: l.opacity };
}

const LAYER_TYPES: LayerType[] = ['heatmap', 'roads', 'openfreemap', 'raster', 'file'];
const KNOWN: Record<LayerType, string[]> = {
  heatmap: ['width'],
  roads: ['width'],
  openfreemap: [],
  raster: ['tiles', 'tileSize', 'minzoom', 'maxzoom', 'bounds', 'attribution'],
  file: ['file'],
};

function readLayers(o: Record<string, unknown> | null, problems: Problem[]): LayerDef[] {
  if (!o) return DEFAULTS.layers.map((l) => ({ ...l }));
  const top = new Fields('layers.json', o, problems, ['layers']);
  const list = o.layers;
  if (list === undefined) return DEFAULTS.layers.map((l) => ({ ...l }));
  if (!Array.isArray(list)) {
    top.bad('"layers" should be a list. Using the default layers instead.');
    return DEFAULTS.layers.map((l) => ({ ...l }));
  }
  const out: LayerDef[] = [];
  const ids = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const at = `Layer ${i + 1}: `;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      top.bad(`${at}should be { "id": …, "type": … }. It is left out.`);
      continue;
    }
    const type = (raw as any).type as LayerType;
    if (!LAYER_TYPES.includes(type)) {
      top.bad(`${at}"type" should be one of ${LAYER_TYPES.map((t) => `"${t}"`).join(', ')}. It is left out.`);
      continue;
    }
    const id = (raw as any).id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      top.bad(`${at}"id" should be a short name of lower-case letters, digits, - or _, like "spain-topo". It is left out.`);
      continue;
    }
    if (ids.has(id)) {
      top.bad(`${at}the id "${id}" is used twice. The second one is left out.`);
      continue;
    }
    if ((type === 'heatmap' || type === 'roads') && out.some((l) => l.type === type)) {
      top.bad(`${at}there can only be one "${type}" layer. This one is left out.`);
      continue;
    }
    const f = new Fields('layers.json', raw as Record<string, unknown>, problems, ['id', 'type', 'name', 'note', 'on', 'opacity', ...KNOWN[type]], `Layer "${id}": `);
    const base: LayerBase = {
      id,
      name: f.get('name', type === 'heatmap' ? 'My rides' : type === 'roads' ? ROADS_LAYER.name : id, text(100)),
      on: f.get('on', true, bool),
      opacity: f.get('opacity', 1, number(0.05, 1)),
    };
    const note = f.get<string | null>('note', null, text(100), 'It is left out.');
    if (note) base.note = note;
    if (type === 'heatmap' || type === 'roads') {
      const width = f.get('width', 1, number(MIN_WIDTH, MAX_WIDTH));
      out.push(width === 1 ? { ...base, type } : { ...base, type, width });
    } else if (type === 'openfreemap') out.push({ ...base, type });
    else if (type === 'file') {
      const file = (raw as any).file;
      if (typeof file !== 'string' || !/^maps\/[^/\\]+\.(pmtiles|mbtiles)$/i.test(file) || file.includes('..')) {
        f.bad('"file" should be a map in the maps folder, like "maps/home.pmtiles". The layer is left out.');
        continue;
      }
      out.push({ ...base, type, file });
    } else {
      const tiles = (raw as any).tiles;
      const tileProblem = tileUrlProblem(tiles);
      if (tileProblem) {
        f.bad(`"tiles" ${tileProblem} The layer is left out.`);
        continue;
      }
      const minzoom = f.get('minzoom', 0, integer(0, 22));
      let maxzoom = f.get('maxzoom', 19, integer(0, 22));
      if (maxzoom < minzoom) {
        f.bad(`"maxzoom" is smaller than "minzoom". Using ${minzoom}.`);
        maxzoom = minzoom;
      }
      const r: LayerDef = {
        ...base, type, tiles: (tiles as string[]).map((t) => t.trim()),
        tileSize: f.get('tileSize', 256, (v) => (v === 256 || v === 512 ? v : bad('should be 256 or 512.'))),
        minzoom, maxzoom,
        attribution: f.get('attribution', '', (v) => (typeof v === 'string' && v.length <= 1000 ? v : bad('should be text of up to 1000 characters.'))),
      };
      const b = f.get<Bounds | null>('bounds', null, bounds, 'It is left out.');
      if (b) r.bounds = b;
      out.push(r);
    }
    ids.add(id);
  }
  if (!out.some((l) => l.type === 'heatmap')) out.unshift({ ...DEFAULTS.layers[0]! });
  // Config folders from before road lines were a layer get one, just under the rides.
  if (!out.some((l) => l.type === 'roads')) out.splice(out.findIndex((l) => l.type === 'heatmap') + 1, 0, { ...ROADS_LAYER, id: ids.has(ROADS_ID) ? freeLayerId(ids) : ROADS_ID });
  return out;
}

function freeLayerId(ids: Set<string>): string {
  let n = 2;
  while (ids.has(`${ROADS_ID}-${n}`)) n++;
  return `${ROADS_ID}-${n}`;
}

/** Where a new map goes: under your rides and road lines, so it does not hide them. */
export function newMapIndex(layers: LayerDef[]): number {
  return Math.max(...layers.map((l, i) => (l.type === 'heatmap' || l.type === 'roads' ? i : -1))) + 1;
}

/** Why a list of tile addresses cannot be used, or null if it can. */
export function tileUrlProblem(tiles: unknown): string | null {
  if (!Array.isArray(tiles) || tiles.length < 1 || tiles.length > 8) return 'should be a list of 1 to 8 web addresses.';
  for (const t of tiles) {
    if (typeof t !== 'string' || t.length > 2000) return 'should be a list of web addresses.';
    let u: URL;
    try {
      u = new URL(t.trim().replace(/\{[a-z]+\}/g, '0'));
    } catch {
      return `has "${t}", which is not a web address.`;
    }
    if (u.protocol !== 'https:') return `has "${t}", which does not start with https://.`;
    if (/[{}]/.test(new URL(t.trim()).host)) return `has "${t}". Put each server in the list separately instead of using {s}.`;
    if (!['{z}', '{x}', '{y}'].every((p) => t.includes(p))) return `has "${t}", which needs {z}, {x} and {y} where the tile numbers go.`;
  }
  return null;
}

// --- writing --------------------------------------------------------------------

const NOTES: Record<(typeof FILES)[number], string> = {
  'map.json': 'Where the map opens and how far it zooms. "view": null fits the map to your rides. "overpass" is where road and trail searches go. See README.md.',
  'heatmap.json': 'Colours by number of passes, lowest first. "label" is optional. "hide" leaves kinds of activity out. radius, angle and step change how rides are matched. See README.md.',
  'layers.json': 'Every layer, top first. Types: heatmap, roads, openfreemap, raster (web tiles), file (a map in the maps folder). See README.md.',
};

/** The JSON for one config file, keeping any // comments and unknown keys from `before`. */
export function fileText(file: (typeof FILES)[number], config: Config, before?: string): string {
  let old: Record<string, unknown> = {};
  try {
    const v = before ? JSON.parse(before) : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) old = v;
  } catch {}
  const value = file === 'map.json' ? config.map : file === 'heatmap.json' ? config.heatmap : { layers: config.layers };
  const comments = Object.fromEntries(Object.entries(old).filter(([k]) => k.startsWith('//')));
  if (!Object.keys(comments).length) comments['//'] = NOTES[file];
  return prettyJson({ ...comments, ...value });
}

/** Indented JSON, with short lists and objects kept on one line so files stay easy to scan. */
export function prettyJson(v: unknown): string {
  const line = (x: unknown): string => {
    if (Array.isArray(x)) return `[${x.map(line).join(', ')}]`;
    if (x && typeof x === 'object') {
      const e = Object.entries(x).filter(([, y]) => y !== undefined);
      return e.length ? `{ ${e.map(([k, y]) => `${JSON.stringify(k)}: ${line(y)}`).join(', ')} }` : '{}';
    }
    return JSON.stringify(x);
  };
  /** `used` is how much of the line is already taken, such as by the key. */
  const go = (x: unknown, pad: string, used: number): string => {
    const one = line(x);
    if (x === null || typeof x !== 'object' || used + one.length <= 100) return one;
    const inner = pad + '  ';
    if (Array.isArray(x)) return `[\n${x.map((y) => inner + go(y, inner, inner.length)).join(',\n')}\n${pad}]`;
    const e = Object.entries(x).filter(([, y]) => y !== undefined);
    return `{\n${e.map(([k, y]) => `${inner}${JSON.stringify(k)}: ${go(y, inner, inner.length + k.length + 4)}`).join(',\n')}\n${pad}}`;
  };
  return go(v, '', 0) + '\n';
}
