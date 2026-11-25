// The website's app behind the window: everything the desktop app's main
// process does for the UI, done in the browser. The config, road data and
// elevation are kept in the browser's database; road data comes straight from
// Overpass, and route planning runs in a Web Worker. There is no server.
// Garmin, rides and map files are left out for now (status.features says so).
import type {
  AreasState, ConfigFile, ConfigImport, ConfigState, PlanNetwork, PlanProgress, Result, RouteDetail, Saved, Status, TrailApi, View,
} from '../core/api.ts';
import { Areas } from '../core/areadata.ts';
import { AREAS_FILE, areasText, type Area, type AreaGroup } from '../core/areas.ts';
import { configZip, readConfigZip } from '../core/configzip.ts';
import { DEFAULTS, FILES, type Config, type LayerDef, type Problem } from '../core/config.ts';
import * as E from '../core/edits.ts';
import { overpass } from '../core/overpass.ts';
import { planMagicJob, planRoutesJob, type NetworkJob, type NetworkResult } from '../core/planjobs.ts';
import type { OsmWay } from '../core/roads.ts';
import { gpxLine, routeGpx, statsOfLine, type PlannedRoute } from '../core/route.ts';
import { isRouteId, parseRoutes, routeFile, ROUTES_FILE, routesText, type SavedRoute } from '../core/routes.ts';
import { shapeBounds } from '../core/shapes.ts';
import { terrainTiles } from '../core/terrain.ts';
import type { Bounds } from '../core/api.ts';
import { ConfigStore } from './configstore.ts';
import { get, put } from './idb.ts';
import { BrowserWayStore } from './osmstore.ts';
import { fetchTerrain } from './terrain.ts';

declare const __TRAIL_VERSION__: string;

export interface WebOptions {
  /** Overpass servers to use instead of the config's. For testing. */
  overpass?: string[];
  /** Where elevation tiles come from, instead of the public ones. For testing. */
  terrain?: string;
}

type Fn<T> = (v: T) => void;
const result = async <T>(fn: () => Promise<T> | T): Promise<Result<T>> => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Something went wrong.' };
  }
};
const notHere = async (): Promise<Result<never>> => ({ ok: false, error: 'This is not available on the website.' });

/** Starts the backend: opens the browser's storage and reads the config. */
export async function webTrail(opts: WebOptions = {}): Promise<TrailApi> {
  const files = new ConfigStore();
  const osm = new BrowserWayStore();
  await Promise.all([files.open(), osm.open()]);
  // Ask the browser not to clear the data when space is short. It may say no; reminders still cover that.
  void navigator.storage?.persist?.().catch(() => {});

  const listeners = { status: new Set<Fn<Status>>(), config: new Set<Fn<ConfigState>>(), areas: new Set<Fn<AreasState>>(), plan: new Set<Fn<PlanProgress>>() };
  const on = <K extends keyof typeof listeners>(k: K, fn: Parameters<(typeof listeners)[K]['add']>[0]) => {
    (listeners[k] as Set<typeof fn>).add(fn);
    return () => void (listeners[k] as Set<typeof fn>).delete(fn);
  };
  const emit = <T>(set: Set<Fn<T>>, v: T) => set.forEach((fn) => fn(v));

  let config: Config = DEFAULTS;
  let problems: Problem[] = [];
  const status = (): Status => ({
    features: { garmin: false, rides: false, mapFiles: false, storage: 'browser' },
    backup: { ...files.backup },
    hasKey: false, keyProblem: null, keyExpires: null,
    sync: { state: 'idle', message: '', done: 0, total: 0, onMap: 0, noGps: 0, failed: 0, lastSync: null, buildingHeatmap: false },
    activities: {}, import: null, heatmapVersion: 0, version: typeof __TRAIL_VERSION__ === 'string' ? __TRAIL_VERSION__ : 'web',
  });
  const configState = (): ConfigState => ({ config, problems, dir: 'This browser', source: 'default', maps: {} });

  const fetchOverpass = (query: string) => overpass(opts.overpass ?? config.map.overpass, query, { fetch: (u, i) => fetch(u, i), online: () => navigator.onLine });
  let areasTimer: ReturnType<typeof setTimeout> | null = null;
  const areasState = (): AreasState => {
    const list = areas.view();
    return { areas: list, groups: areas.groupView(list) };
  };
  const areas = new Areas(osm, fetchOverpass, () => {
    areasTimer ??= setTimeout(() => {
      areasTimer = null;
      emit(listeners.areas, areasState());
    }, 100);
  });

  const reload = () => {
    const r = files.load();
    config = r.config;
    problems = r.problems;
    areas.set(config.areas, config.groups);
    emit(listeners.config, configState());
    emit(listeners.status, status());
  };
  reload();

  // Leaving with changes that are only in this browser: the browser asks first.
  addEventListener('beforeunload', (e) => {
    if (files.backup.unsaved > 0) e.preventDefault();
  });

  // One change to areas.json at a time, each from the file as it is now.
  let areaWrites: Promise<unknown> = Promise.resolve();
  const editAreas = (fn: (areas: Area[], groups: AreaGroup[]) => { areas: Area[]; groups: AreaGroup[] }) => {
    const next = areaWrites.then(async () => {
      if (problems.some((p) => p.file === AREAS_FILE)) throw new Error(`${AREAS_FILE} has a problem, so the app will not change it. Fix it, or import a config that works.`);
      const r = fn(config.areas, config.groups);
      await files.write(AREAS_FILE, areasText(r.areas, r.groups, files.read(AREAS_FILE)));
      reload();
    });
    areaWrites = next.catch(() => {});
    return next;
  };
  const writeLayers = async (layers: LayerDef[]) => {
    await files.write('layers.json', E.configFileText('layers.json', { layers }, config, files.read('layers.json')));
    reload();
  };

  // Route planning runs in a worker. One at a time is enough: each job is quick, or the last one wanted.
  let worker: Worker | null = null;
  let jobNo = 0;
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const runJob = <T>(job: string, payload: unknown): Promise<T> => {
    if (!worker) {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const w = waiting.get(data.id);
        waiting.delete(data.id);
        if (data.error) w?.reject(new Error(data.error));
        else w?.resolve(data.result);
      };
    }
    const id = ++jobNo;
    return new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker!.postMessage({ id, job, payload });
    });
  };
  let planned: PlannedRoute[] = [];
  let preparing = 0;

  // One change to the saved routes at a time.
  let routeWrites: Promise<unknown> = Promise.resolve();
  const editRoutes = <T>(fn: (list: SavedRoute[]) => Promise<{ list: SavedRoute[]; value: T }>): Promise<T> => {
    const next = routeWrites.then(async () => {
      const r = await fn(parseRoutes(files.read(ROUTES_FILE)));
      await files.write(ROUTES_FILE, routesText(r.list, files.read(ROUTES_FILE)));
      emit(listeners.status, status());
      return r.value;
    });
    routeWrites = next.catch(() => {});
    return next;
  };

  const saved = async (): Promise<Saved> => ({ view: null, focus: null, showZones: false, ...((await get<Partial<Saved>>('meta', 'saved')) ?? {}) });
  const saveSaved = async (s: Partial<Saved>) => put('meta', [['saved', { ...(await saved()), ...s }]]);

  return {
    getStatus: async () => status(),
    onStatus: (fn) => on('status', fn),
    saveKey: notHere, setKeyExpires: notHere, removeKey: notHere, syncNow: notHere, importRides: notHere, deleteRides: notHere,
    getConfig: async () => configState(),
    onConfig: (fn) => on('config', fn),
    saveConfig: (file, value) => result(async () => {
      if (!FILES.includes(file as ConfigFile)) throw new Error('Unknown config file.');
      await files.write(file, E.configFileText(file, value, config, files.read(file)));
      reload();
    }),
    saveLayers: (ls) => result(() => writeLayers(E.layersFromState(config.layers, ls))),
    pickMap: notHere, addDroppedMap: notHere, renameMap: notHere, removeMap: notHere,
    addZone: notHere, editZone: notHere, removeZone: notHere,
    exportConfig: () => result(async () => {
      download(`trail-explorer-config-${new Date().toISOString().slice(0, 10)}.zip`, configZip(files.all()) as Uint8Array<ArrayBuffer>, 'application/zip');
      await files.exported();
      emit(listeners.status, status());
      return true;
    }),
    importConfig: (zip) => result(async (): Promise<ConfigImport> => {
      if (!(zip instanceof Uint8Array)) throw new Error('That file could not be read.');
      const z = readConfigZip(zip);
      await files.importFiles(z.files);
      reload();
      return { files: Object.keys(z.files).length, skipped: z.skipped, problems: z.problems.length };
    }),
    pickConfigDir: notHere, useDefaultConfigDir: notHere, openConfigDir: async () => {},
    getSaved: saved,
    saveView: async (v: View) => {
      if (Array.isArray(v?.center) && v.center.length === 2 && [...v.center, v.zoom].every(Number.isFinite)) await saveSaved({ view: { center: v.center, zoom: v.zoom } });
    },
    saveShowZones: async () => {},

    getAreas: async () => areasState(),
    onAreas: (fn) => on('areas', fn),
    getAreaRoads: (id) => result(() => {
      const c = typeof id === 'string' ? areas.roadsOf(id) : null;
      return c ? { version: c.version, roads: c.roads } : { version: 0, roads: [] };
    }),
    addArea: (a) => result(async () => {
      let id = '';
      await editAreas((list, groups) => {
        const r = E.addArea({ areas: list, groups }, a);
        id = r.id;
        return r;
      });
      return id;
    }),
    editArea: (id, e) => result(() => editAreas((list, groups) => E.editArea({ areas: list, groups }, id, e))),
    removeArea: (id) => result(async () => {
      await editAreas((list, groups) => E.removeArea({ areas: list, groups }, id));
      areas.prune();
    }),
    retryArea: (id) => result(() => {
      if (typeof id === 'string') areas.retry(id);
    }),
    addGroup: (name, ids) => result(async () => {
      let id = '';
      await editAreas((list, groups) => {
        const r = E.addGroup({ areas: list, groups }, name, ids);
        id = r.id;
        return r;
      });
      return id;
    }),
    editGroup: (id, e) => result(() => editAreas((list, groups) => E.editGroup({ areas: list, groups }, id, e))),
    removeGroup: (id, withAreas) => result(async () => {
      await editAreas((list, groups) => E.removeGroup({ areas: list, groups }, id, withAreas));
      if (withAreas === true) areas.prune();
    }),

    planPrepare: (ids) => result(async (): Promise<PlanNetwork> => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 50) throw new Error('Choose at least one area.');
      const n = ++preparing;
      const progress = (p: PlanProgress) => emit(listeners.plan, p);
      const chosen = areas.view().filter((a) => ids.includes(a.id));
      if (chosen.length !== ids.length) throw new Error('One of those areas is no longer there.');
      const waitingArea = chosen.find((a) => a.state !== 'ready');
      if (waitingArea) throw new Error(`${waitingArea.name ?? 'An area'} is still downloading. Wait for it, or leave it out.`);
      progress({ stage: 'roads', done: 0, total: 1 });
      const ways = new Map<number, OsmWay>();
      for (const a of chosen) for (const w of osm.waysIn(a.shape)) ways.set(w.id, w);
      const shapes = chosen.map((a) => a.shape);
      const boxes = shapes.map(shapeBounds);
      const bounds: Bounds = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
      const want = new Map<string, [number, number]>();
      for (const b of boxes) for (const t of terrainTiles(b)) want.set(t.join('/'), t);
      const missingElevation = await fetchTerrain([...want.values()], (done, total) => n === preparing && progress({ stage: 'elevation', done, total }), opts.terrain);
      if (n !== preparing) throw new Error('Replaced by a newer request.');
      progress({ stage: 'network', done: 0, total: 1 });
      const key = `${n}:${ids.join(',')}`;
      const out = await runJob<NetworkResult>('planNetwork', { key, ways: [...ways.values()], shapes, tracks: [], bounds, terrain: 'browser' } satisfies NetworkJob);
      return { key, ...out, bounds, missingElevation };
    }),
    onPlanProgress: (fn) => on('plan', fn),
    planRoutes: (key, r, o) => result(async () => {
      planned = await runJob<PlannedRoute[]>('planRoutes', planRoutesJob(key, r, o));
      if (!planned.length) throw new Error('No routes could be made from there. Try a shorter distance, more kinds of path, or a start inside an area.');
      return planned;
    }),
    planMagic: (key, r, o) => result(async () => {
      planned = await runJob<PlannedRoute[]>('planMagic', planMagicJob(key, r, o));
      return planned;
    }),

    getRoutes: async () => parseRoutes(files.read(ROUTES_FILE)),
    getRoute: (id) => result((): RouteDetail => {
      const route = parseRoutes(files.read(ROUTES_FILE)).find((r) => r.id === id);
      if (!route) throw new Error('That route is no longer saved.');
      const gpx = files.read(routeFile(route.id));
      if (!gpx) throw new Error(`The file ${routeFile(route.id)} is missing from the config.`);
      const line = gpxLine(gpx);
      return { route, line, stats: statsOfLine(line) };
    }),
    saveRoute: (plannedId, name) => result(() => {
      const p = planned.find((x) => x.id === plannedId);
      if (!p) throw new Error('That route is no longer on screen. Plan again to save it.');
      return editRoutes(async (list) => {
        const { route, gpx } = E.savedRoute(list, p, name);
        await files.write(routeFile(route.id), gpx);
        return { list: [...list, route], value: route };
      });
    }),
    renameRoute: (id, name) => result(() => {
      if (typeof name !== 'string' || !name.trim()) throw new Error('A route needs a name.');
      return editRoutes(async (list) => {
        const r = list.find((x) => x.id === id);
        if (!r) throw new Error('That route is no longer saved.');
        r.name = name.trim().slice(0, 100);
        const gpx = files.read(routeFile(r.id));
        if (gpx) await files.write(routeFile(r.id), routeGpx(r.name, gpxLine(gpx), r.created));
        return { list, value: undefined };
      });
    }),
    deleteRoute: (id) => result(() => editRoutes(async (list) => {
      if (!isRouteId(id)) throw new Error('Unknown route.');
      await files.remove(routeFile(id));
      return { list: list.filter((r) => r.id !== id), value: undefined };
    })),
    exportRoute: (id) => result(() => {
      const route = parseRoutes(files.read(ROUTES_FILE)).find((r) => r.id === id);
      const gpx = route && files.read(routeFile(route.id));
      if (!route || !gpx) throw new Error('That route is no longer saved.');
      download(E.gpxName(route.name), gpx, 'application/gpx+xml');
      return true;
    }),
  };
}

/** Hands the browser a file to save, as a download. */
function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

