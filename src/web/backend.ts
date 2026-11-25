// The website's app behind the window: everything the desktop app's main
// process does for the UI, done in the browser. The config, road data and
// elevation are kept in the browser's database; road data comes straight from
// Overpass, and route planning runs in a Web Worker. There is no server.
// Rides come from an export .zip read in the browser; Garmin sync and map files
// are left out for now (status.features says so).
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
import { APP_ZONES } from '../core/config.ts';
import { Importer } from '../core/importer.ts';
import { addCircle, editCircle, removeZone } from '../core/zones.ts';
import { ConfigStore } from './configstore.ts';
import { BrowserRideStore } from './ridestore.ts';
import { rideFilesIn } from './zipread.ts';
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
export async function webTrail(opts: WebOptions = {}): Promise<{ trail: TrailApi; heatmapUrl(version: number): string }> {
  const files = new ConfigStore();
  const osm = new BrowserWayStore();
  const rides = new BrowserRideStore();
  await Promise.all([files.open(), osm.open(), rides.open()]);
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
  // The heatmap: drawn in the worker from the rides, kept in the browser's database, and shown from memory.
  let heat = (await get<{ key: string; json: string; focus: Bounds | null; version: number }>('meta', 'heatmap')) ?? null;
  let heatUrl: string | null = null;
  let building = false, buildAgain = false;
  const status = (): Status => {
    const c = rides.counts();
    return {
      features: { garmin: false, rides: true, mapFiles: false, storage: 'browser' },
      backup: { ...files.backup },
      hasKey: false, keyProblem: null, keyExpires: null,
      sync: { state: 'idle', message: '', done: c.done + c.noGps, total: c.done + c.noGps, onMap: c.done, noGps: c.noGps, failed: 0, lastSync: null, buildingHeatmap: building },
      activities: rides.activityCounts(), import: importer.status, heatmapVersion: heat?.version ?? 0,
      version: typeof __TRAIL_VERSION__ === 'string' ? __TRAIL_VERSION__ : 'web',
    };
  };
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
    if (heatKey() !== heat?.key) void buildHeatmap();
  };

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
  /** Never draw without knowing every zone: the heatmap would show what they hide. */
  const zonesBlocked = () => problems.some((p) => p.file.startsWith('zones/'));
  /** Everything in the config that changes the heatmap, and how many rides there are. When it changes, the heatmap is drawn again. */
  const heatKey = () => {
    const { bands, radius, angle, step, hide } = config.heatmap;
    const zones = config.zones.map((z) => (z.kind === 'circle' ? [z.center, z.radius] : z.polygons));
    return JSON.stringify({ zones, bands: bands.map((b) => b.from), radius, angle, step, hide: [...hide].sort(), rides: rides.counts().done });
  };
  async function buildHeatmap() {
    if (zonesBlocked()) return;
    if (building) {
      buildAgain = true;
      return;
    }
    building = true;
    emit(listeners.status, status());
    try {
      do {
        buildAgain = false;
        if (zonesBlocked()) break;
        const key = heatKey();
        const { bands, radius, angle, step } = config.heatmap;
        const out = await runJob<{ json: string; focus: Bounds | null }>('heatmap', {
          tracks: await rides.tracks(config.heatmap.hide), zones: config.zones, options: { radius, angle, step, bands: bands.map((b) => b.from) },
        });
        heat = { key, json: out.json, focus: out.focus, version: (heat?.version ?? 0) + 1 };
        await put('meta', [['heatmap', heat]]);
        // The map may still read the old one until it gets the new style, so it goes a little later.
        const old = heatUrl;
        if (old) setTimeout(() => URL.revokeObjectURL(old), 60_000);
        heatUrl = null;
        await saveSaved({ focus: out.focus });
      } while (buildAgain);
    } catch (e) {
      console.error('Heatmap build failed:', e);
    } finally {
      building = false;
      emit(listeners.status, status());
    }
  }
  const heatmapUrl = () => {
    heatUrl ??= URL.createObjectURL(new Blob([heat?.json ?? '{"type":"FeatureCollection","features":[]}'], { type: 'application/json' }));
    return heatUrl;
  };

  const importer = new Importer({
    store: rides,
    // A copy of the bytes goes to the worker, so the export's own buffer is never moved.
    readFile: (name, data) => runJob('readFile', { name, data: data.slice() }),
    ridesChanged: () => void buildHeatmap(),
    changed: () => emit(listeners.status, status()),
  });
  /** Asks for an export .zip. Null when none is chosen. Must be called straight from a click. */
  const pickZip = () => new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      input.remove();
      resolve(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });

  const zoneEdit = (fn: (text: string | undefined) => string) => result(async () => {
    await files.write(APP_ZONES, fn(files.read(APP_ZONES)));
    reload();
  });
  const appZone = (id: unknown): number => {
    const z = config.zones.find((x) => x.id === id);
    if (!z || z.file !== APP_ZONES) throw new Error('That zone is in a file the app does not change. Export the config to edit it.');
    return z.index;
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

  const saved = async (): Promise<Saved> => ({ view: null, focus: null, showZones: true, ...((await get<Partial<Saved>>('meta', 'saved')) ?? {}) });
  const saveSaved = async (s: Partial<Saved>) => put('meta', [['saved', { ...(await saved()), ...s }]]);

  reload();

  const trail: TrailApi = {
    getStatus: async () => status(),
    onStatus: (fn) => on('status', fn),
    saveKey: notHere, setKeyExpires: notHere, removeKey: notHere, syncNow: notHere,
    importRides: async () => {
      if (importer.status?.state === 'reading') return { ok: false, error: 'An import is already running.' };
      const file = await pickZip();
      if (!file) return { ok: true, value: null };
      return result(() => importer.run(file.name, () => rideFilesIn(file)));
    },
    deleteRides: () => result(async () => {
      if (importer.status?.state === 'reading') throw new Error('Wait for the import to finish first.');
      await rides.deleteAll();
      await saveSaved({ focus: null });
      void buildHeatmap();
      emit(listeners.status, status());
    }),
    getConfig: async () => configState(),
    onConfig: (fn) => on('config', fn),
    saveConfig: (file, value) => result(async () => {
      if (!FILES.includes(file as ConfigFile)) throw new Error('Unknown config file.');
      await files.write(file, E.configFileText(file, value, config, files.read(file)));
      reload();
    }),
    saveLayers: (ls) => result(() => writeLayers(E.layersFromState(config.layers, ls))),
    pickMap: notHere, addDroppedMap: notHere, renameMap: notHere, removeMap: notHere,
    addZone: (z) => zoneEdit((t) => addCircle(t, { name: z?.name, center: z?.center, radius: z?.radius })),
    editZone: (id, e) => result(() => appZone(id)).then((r) => (r.ok ? zoneEdit((t) => editCircle(t, r.value, { name: e?.name, center: e?.center, radius: e?.radius })) : r)),
    removeZone: (id) => result(() => appZone(id)).then((r) => (r.ok ? zoneEdit((t) => removeZone(t, r.value)) : r)),
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
    saveShowZones: async (on) => {
      if (typeof on === 'boolean') await saveSaved({ showZones: on });
    },

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
      const out = await runJob<NetworkResult>('planNetwork', { key, ways: [...ways.values()], shapes, tracks: await rides.tracks(config.heatmap.hide), bounds, terrain: 'browser' } satisfies NetworkJob);
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
  return { trail, heatmapUrl };
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

