import { constants, mkdirSync, watch } from 'node:fs';
import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, utilityProcess, type UtilityProcess } from 'electron';
import type { AreaView, Bounds, ConfigFile, ConfigState, LayerState, MapInfo, Result, Saved, Status, View } from '../core/api.ts';
import { APP_ZONES, checkFile, DEFAULTS, FILES, fileText, mapOrigins, parseConfig, type Config, type LayerDef, type Problem } from '../core/config.ts';
import { AREAS_FILE, areasText, checkAreaEdit, newAreaId, type Area, type AreaEdit } from '../core/areas.ts';
import { Areas } from './areas.ts';
import { OsmStore } from './osm.ts';
import { addCircle, editCircle, removeZone, type CircleEdit } from '../core/zones.ts';
import { ConfigDir } from './configdir.ts';
import { Busy, Garmin, GARMIN, KeyRejected, Offline } from './garmin.ts';
import { KeyFile } from './key.ts';
import { Maps, slug } from './maps.ts';
import { Store } from './store.ts';
import { Sync } from './sync.ts';

const root = app.getAppPath();
const here = join(root, 'out', 'main');
const resources = app.isPackaged ? join(process.resourcesPath, 'resources') : join(root, 'resources');
const uiDir = join(here, '..', 'ui');

// Anything not packaged is a development copy. It has its own data folder and
// keychain entry, so it can run beside the real app and never touches its rides or key.
const appName = app.isPackaged ? 'Trail Explorer' : 'Trail Explorer Dev';
app.setName(appName);
/** Address of the hot reload server under `npm run dev`, otherwise null. */
const devServer = !app.isPackaged && /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.ELECTRON_RENDERER_URL ?? '') ? process.env.ELECTRON_RENDERER_URL! : null;
// Test hooks. They do nothing in the packaged app.
const test = app.isPackaged ? {} : { data: process.env.TRAIL_TEST_DATA, garmin: process.env.TRAIL_TEST_GARMIN, overpass: process.env.TRAIL_TEST_OVERPASS };
app.setPath('userData', test.data ?? join(app.getPath('appData'), appName));
const garminBase = test.garmin?.startsWith('http://127.0.0.1:') ? test.garmin : GARMIN;

protocol.registerSchemesAsPrivileged([
  { scheme: 'trail', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

/** The window may only load from the app itself and the web maps named in the config. */
const csp = (layers: LayerDef[]) => {
  const hosts = mapOrigins(layers).join(' ');
  return [
    "default-src 'none'",
    // Hot reload adds an inline script and a socket. Never in the packaged app.
    `script-src 'self'${devServer ? " 'unsafe-inline'" : ''}`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' trail: data: blob: ${hosts}`,
    `connect-src 'self' trail: blob: ${hosts}${devServer ? ` ${devServer.replace('http', 'ws')}` : ''}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
};
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.pbf': 'application/x-protobuf', '.svg': 'image/svg+xml',
};

function start() {
  const data = app.getPath('userData');
  mkdirSync(join(data, 'heatmap'), { recursive: true });
  const heatFile = join(data, 'heatmap', 'heatmap.json');
  const ridesDir = join(data, 'rides');
  const store = new Store(join(data, 'trail-explorer.db'));
  const keyFile = new KeyFile(join(data, 'key.bin'), { allowPlain: test.data !== undefined });

  let win: BrowserWindow | null = null;
  let hasKey = false;
  let keyUnreadable: string | null = null;
  let building = false;
  let buildAgain = false;

  // --- worker ---------------------------------------------------------------
  let worker: UtilityProcess | null = null;
  let jobId = 0;
  const jobs = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  const runJob = <T>(job: string, payload: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      if (!worker) {
        const w = utilityProcess.fork(join(here, 'worker.cjs'), [], { serviceName: 'Trail Explorer worker' });
        worker = w;
        w.on('message', (m) => {
          const j = jobs.get(m.id);
          jobs.delete(m.id);
          if (m.error !== undefined) j?.reject(new Error(m.error));
          else j?.resolve(m.result);
        });
        w.on('exit', () => {
          if (worker !== w) return;
          worker = null;
          for (const j of jobs.values()) j.reject(new Error('The background worker stopped.'));
          jobs.clear();
        });
      }
      const id = ++jobId;
      jobs.set(id, { resolve, reject });
      worker.postMessage({ id, job, payload });
    });

  // --- heatmap --------------------------------------------------------------
  let version = store.get<number>('heatmapVersion') ?? 0;
  /** Everything in the config that changes the heatmap. When it changes, the heatmap is drawn again. */
  const heatKey = () => {
    const { bands, radius, angle, step } = config.heatmap;
    const zones = config.zones.map((z) => (z.kind === 'circle' ? [z.center, z.radius] : z.polygons));
    return JSON.stringify({ zones, bands: bands.map((b) => b.from), radius, angle, step });
  };
  async function buildHeatmap() {
    // Never draw without knowing every zone: the heatmap would show what they hide.
    if (zonesBlocked()) return;
    if (building) {
      buildAgain = true;
      return;
    }
    building = true;
    changed();
    try {
      do {
        buildAgain = false;
        if (zonesBlocked()) break;
        const key = heatKey();
        const { bands, radius, angle, step } = config.heatmap;
        const out = await runJob<{ json: string; focus: Bounds | null }>('heatmap', {
          tracks: store.tracks(), zones: config.zones, options: { radius, angle, step, bands: bands.map((b) => b.from) },
        });
        await writeFile(`${heatFile}.part`, out.json);
        await rename(`${heatFile}.part`, heatFile);
        store.set('focus', out.focus);
        store.set('heatmapKey', key);
        store.set('heatmapVersion', ++version);
        changed();
      } while (buildAgain);
    } catch (e) {
      console.error('Heatmap build failed:', e);
    } finally {
      building = false;
      changed();
    }
  }

  // --- config ---------------------------------------------------------------
  // The config folder is the one place for how the map looks. The app reads it,
  // writes it when something is changed in the window, and watches it for edits.
  const envDir = process.env.TRAIL_CONFIG?.trim() || null;
  const configPath = (): { dir: string; source: ConfigState['source'] } => {
    if (envDir) return { dir: resolve(envDir), source: 'env' };
    const chosen = store.get<string>('configDir');
    return chosen ? { dir: chosen, source: 'chosen' } : { dir: join(data, 'config'), source: 'default' };
  };
  let where = configPath();
  let cfgDir = new ConfigDir(where.dir);
  const maps = new Maps(join(where.dir, 'maps'));
  let config: Config = DEFAULTS;
  let problems: Problem[] = [];

  // Asks the config's Overpass servers for OpenStreetMap data. Public servers are
  // often full, so busy answers are retried, then the next server is tried.
  const BUSY = [429, 502, 503, 504];
  const WAITS = [0, 3000, 8000, 20000];
  async function overpass(query: string): Promise<unknown> {
    const servers = test.overpass?.startsWith('http://127.0.0.1:') ? [test.overpass] : config.map.overpass;
    const body = new URLSearchParams({ data: query }).toString();
    let why = 'busy';
    for (const server of servers) {
      for (const ms of WAITS) {
        if (ms) await new Promise((r) => setTimeout(r, test.overpass ? ms / 20 : ms));
        let res: Response;
        try {
          res = await net.fetch(server, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body,
            signal: AbortSignal.timeout(180_000),
          });
        } catch (e) {
          if (!net.isOnline()) throw new Error('No internet. Downloading roads and trails needs it. Try again when you are online.');
          why = (e as Error).name === 'TimeoutError' ? 'slow' : 'unreachable';
          break; // try the next server
        }
        if (BUSY.includes(res.status)) {
          why = 'busy';
          await res.body?.cancel();
          continue;
        }
        if (!res.ok) {
          why = `error ${res.status}`;
          break;
        }
        const text = await res.text();
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          why = 'garbled';
          break;
        }
        // Overpass reports running out of time or memory here, with a 200.
        if (typeof json?.remark === 'string' && /error/i.test(json.remark)) {
          why = 'unfinished';
          break;
        }
        return json;
      }
    }
    const host = servers.length === 1 ? new URL(servers[0]!).host : 'Every map data server';
    throw new Error(
      why === 'busy' ? `${host} is busy. Try again in a minute, or add another server in Customize.`
        : why === 'slow' ? `${host} took too long. Try again later.`
        : why === 'unfinished' ? `${host} could not finish. Try again later.`
        : why === 'unreachable' ? `Could not reach ${host}.`
        : `${host} sent something unexpected (${why}).`,
    );
  }
  const osm = new OsmStore(join(data, 'osm.db'));
  let areasTimer: NodeJS.Timeout | null = null;
  const areas = new Areas(osm, overpass, () => {
    areasTimer ??= setTimeout(() => {
      areasTimer = null;
      if (win && !win.isDestroyed()) win.webContents.send('trail:areas', areas.view());
    }, 100);
  });
  let mapInfos: Record<string, MapInfo> = {};
  let stopWatching = () => {};
  let configLoaded = false;
  /** True until the config is read, and while any zones file has a problem. */
  const zonesBlocked = () => !configLoaded || problems.some((p) => p.file.startsWith('zones/'));

  const configState = (): ConfigState => ({ config, problems, dir: cfgDir.dir, source: where.source, maps: mapInfos });
  const sendConfig = () => {
    if (win && !win.isDestroyed()) win.webContents.send('trail:config', configState());
  };

  /** What a map file holds. Cached, since reading a big map's real area takes a while. */
  async function mapInfo(file: string): Promise<Omit<MapInfo, 'id' | 'name'>> {
    const full = join(cfgDir.dir, 'maps', basename(file));
    const st = await stat(full);
    const key = `${full}:${st.size}:${st.mtimeMs}`;
    const known = store.mapInfo(key);
    if (known) return known;
    const info = await maps.inspect(file);
    store.saveMapInfo(key, info);
    return info;
  }

  async function reloadConfig() {
    const r = await cfgDir.load();
    const found = [...r.problems];
    const infos: Record<string, MapInfo> = {};
    for (const l of r.config.layers) {
      if (l.type !== 'file') continue;
      try {
        infos[l.id] = { id: l.id, name: l.name, ...(await mapInfo(l.file)) };
        maps.register(l.id, l.file);
      } catch (e) {
        const gone = (e as NodeJS.ErrnoException).code === 'ENOENT';
        found.push({ file: 'layers.json', message: `Layer "${l.id}": ${l.file} ${gone ? 'is not in the folder' : `could not be read. ${(e as Error).message}`}. The layer is not shown.` });
      }
    }
    for (const id of maps.ids()) if (!infos[id]) maps.forget(id);
    const before = mapOrigins(config.layers).join(' ');
    if (found.some((p) => p.file.startsWith('zones/'))) {
      found.push({ file: 'zones/', message: 'The heatmap is not redrawn until the zones files have no problems, so nothing they should hide can show.' });
    }
    config = r.config;
    problems = found;
    mapInfos = infos;
    configLoaded = true;
    areas.set(config.areas);
    if (heatKey() !== store.get<string>('heatmapKey')) void buildHeatmap();
    // New web maps need a new security policy, which needs a fresh page.
    if (win && !win.isDestroyed() && mapOrigins(config.layers).join(' ') !== before) win.webContents.reload();
    else sendConfig();
  }
  // One reload at a time, in order.
  let loading: Promise<void> = Promise.resolve();
  const reload = () => (loading = loading.then(reloadConfig).catch((e) => console.error('Config reload failed:', e)));

  /** Layer state saved before the config folder existed: order, on and opacity. */
  const oldLayers = () => store.get<LayerState[]>('layers');
  function applyOld(layers: LayerDef[], old: LayerState[] | null, ids: Record<string, string> = {}): LayerDef[] {
    if (!old) return layers;
    const order = old.map((o) => ids[o.id] ?? o.id);
    const out = layers.map((l) => {
      const o = old.find((x) => (ids[x.id] ?? x.id) === l.id);
      return o ? { ...l, on: o.on, opacity: Math.max(0.05, Math.min(1, o.opacity)) } : l;
    });
    const rank = (l: LayerDef) => (order.includes(l.id) ? order.indexOf(l.id) : order.length);
    return out.map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map((x) => x.l);
  }

  /** Moves maps added by earlier versions from the data folder into the config folder. */
  async function moveOldMaps() {
    const old = store.oldMaps();
    const saved = oldLayers();
    if (!old.length) {
      if (saved) store.set('layers', null);
      return;
    }
    const { config: c } = await cfgDir.load();
    let layers = [...c.layers];
    const ids: Record<string, string> = {};
    for (const m of old) {
      const src = join(data, 'maps', basename(m.file));
      const ext = extname(m.file);
      const stem = slug(m.info.name);
      let id = stem;
      const taken = async (x: string) => layers.some((l) => l.id === x) || (await stat(join(cfgDir.dir, 'maps', `${x}${ext}`)).then(() => true, () => false));
      for (let n = 2; await taken(id); n++) id = `${stem}-${n}`;
      try {
        await copyFile(src, join(cfgDir.dir, 'maps', `${id}${ext}`), constants.COPYFILE_FICLONE);
      } catch (e) {
        console.error('Could not move map', m.info.name, e);
        continue;
      }
      ids[m.id] = id;
      const at = layers.findIndex((l) => l.type === 'heatmap') + 1;
      layers.splice(at, 0, { id, type: 'file', name: m.info.name.slice(0, 100) || 'Map', file: `maps/${id}${ext}`, on: true, opacity: 1 });
    }
    layers = applyOld(layers, saved, ids);
    await cfgDir.write('layers.json', fileText('layers.json', { ...c, layers }, await cfgDir.read('layers.json')));
    for (const m of old) {
      if (!ids[m.id]) continue;
      store.forgetOldMap(m.id);
      await rm(join(data, 'maps', basename(m.file)), { force: true });
    }
    store.set('layers', null);
  }

  /** Opens the config folder, making it first if it is new. */
  async function openConfig() {
    stopWatching();
    where = configPath();
    cfgDir = new ConfigDir(where.dir);
    await maps.setDir(join(where.dir, 'maps'));
    mapInfos = {};
    if (!(await cfgDir.exists())) await cfgDir.create({ ...DEFAULTS, layers: applyOld(DEFAULTS.layers, oldLayers()) });
    await moveOldMaps();
    await reload();
    stopWatching = cfgDir.watch(() => void reload());
  }

  /** Writes layers.json with new layers, keeping its comments. */
  async function writeLayers(layers: LayerDef[]) {
    await cfgDir.write('layers.json', fileText('layers.json', { ...config, layers }, await cfgDir.read('layers.json')));
    await reload();
  }
  const freeId = (want: string) => {
    let id = want;
    for (let n = 2; config.layers.some((l) => l.id === id); n++) id = `${want}-${n}`;
    return id;
  };
  /** "zones/zones.geojson#3" to its position, for zones the app may change. */
  const appZone = (id: unknown): number => {
    const z = config.zones.find((x) => x.id === id);
    if (!z || z.file !== APP_ZONES) throw new Error('That zone is in a file the app does not change. Edit the file instead.');
    return z.index;
  };

  // --- status ---------------------------------------------------------------
  const garmin = new Garmin(async () => {
    try {
      return await keyFile.load();
    } catch {
      keyUnreadable = 'Your saved key could not be read. Please enter it again.';
      throw new KeyRejected(keyUnreadable);
    }
  }, garminBase);
  const sync = new Sync({
    store, garmin, ridesDir,
    readRide: (zip) => runJob('read', zip),
    ridesChanged: () => void buildHeatmap(),
    changed: () => changed(),
  });
  function status(): Status {
    const c = store.counts();
    return {
      hasKey,
      keyProblem: keyUnreadable ?? sync.keyProblem,
      keyExpires: store.get<string>('keyExpires'),
      sync: {
        state: sync.state, message: sync.message, done: c.total - c.waiting, total: c.total, onMap: c.done,
        noGps: c['no-gps'], failed: c.failed + c.unread, lastSync: store.get<string>('lastSync'), buildingHeatmap: building,
      },
      heatmapVersion: version,
      version: app.getVersion(),
    };
  }
  let timer: NodeJS.Timeout | null = null;
  function changed() {
    timer ??= setTimeout(() => {
      timer = null;
      if (win && !win.isDestroyed()) win.webContents.send('trail:status', status());
    }, 100);
  }

  // --- messages from the window ----------------------------------------------
  const handle = (name: string, fn: (...a: any[]) => unknown) =>
    ipcMain.handle(`trail:${name}`, (ev, ...args) => {
      if (ev.senderFrame !== win?.webContents.mainFrame || !ev.senderFrame?.url.startsWith('trail://app/')) throw new Error('Refused.');
      return fn(...args);
    });
  const result = async <T>(fn: () => Promise<T> | T): Promise<Result<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Something went wrong.' };
    }
  };
  const dateOrNull = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const isId = (v: unknown): v is string => typeof v === 'string' && v.length < 100;

  handle('getStatus', status);
  handle('saveKey', (key: unknown, expires: unknown) =>
    result(async () => {
      if (typeof key !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(key.trim())) throw new Error('That does not look like a Garmin key. Copy the whole key, with no spaces.');
      const k = key.trim();
      try {
        await garmin.exchange(k);
      } catch (e) {
        if (e instanceof KeyRejected) throw new Error('Garmin did not accept this key. Check that you copied all of it and that it has not expired.');
        if (e instanceof Offline) throw new Error('Could not reach Garmin. Check your internet connection and try again.');
        if (e instanceof Busy) throw new Error('Garmin is busy right now. Wait a minute and try again.');
        throw e;
      }
      await sync.stop();
      await keyFile.save(k);
      garmin.forget();
      store.set('keyExpires', dateOrNull(expires));
      hasKey = true;
      keyUnreadable = sync.keyProblem = null;
      sync.start();
      changed();
    }));
  handle('setKeyExpires', (d: unknown) => result(() => {
    store.set('keyExpires', dateOrNull(d));
    changed();
  }));
  handle('removeKey', () => result(async () => {
    await sync.stop();
    await keyFile.remove();
    garmin.forget();
    store.set('keyExpires', null);
    hasKey = false;
    keyUnreadable = sync.keyProblem = null;
    changed();
  }));
  handle('syncNow', () => result(() => {
    if (!hasKey) throw new Error('Add your Garmin key first.');
    sync.start();
  }));
  handle('deleteRides', () => result(async () => {
    await sync.stop();
    store.deleteRides();
    await rm(ridesDir, { recursive: true, force: true });
    await buildHeatmap();
    changed();
  }));
  handle('getConfig', configState);
  handle('saveConfig', (file: unknown, value: unknown) => result(async () => {
    if (!FILES.includes(file as ConfigFile)) throw new Error('Unknown config file.');
    const f = file as ConfigFile;
    const bad = checkFile(f, value);
    if (bad.length) throw new Error(bad.map((p) => p.message).join(' '));
    // Read back the same way a hand-edited file would be, so both end up alike.
    const next = parseConfig({ [f]: JSON.stringify(value) }).config;
    await cfgDir.write(f, fileText(f, { ...config, map: next.map, heatmap: next.heatmap, layers: f === 'layers.json' ? next.layers : config.layers }, await cfgDir.read(f)));
    await reload();
  }));
  handle('saveLayers', (ls: unknown) => result(async () => {
    if (!Array.isArray(ls) || ls.length > 500) throw new Error('Unknown layers.');
    const state = new Map<string, LayerState>();
    for (const l of ls) if (isId(l?.id) && typeof l.on === 'boolean' && Number.isFinite(l.opacity)) state.set(l.id, l);
    const order = [...state.keys()];
    const rank = (l: LayerDef) => (state.has(l.id) ? order.indexOf(l.id) : order.length);
    const layers = config.layers
      .map((l) => {
        const st = state.get(l.id);
        return st ? { ...l, on: st.on, opacity: Math.max(0.05, Math.min(1, Math.round(st.opacity * 100) / 100)) } : l;
      })
      .map((l, i) => ({ l, i }))
      .sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i)
      .map((x) => x.l);
    await writeLayers(layers);
  }));
  const addMap = (path: unknown) => result(async (): Promise<MapInfo> => {
    if (typeof path !== 'string' || !path) throw new Error('That file could not be opened.');
    const { file, info } = await maps.add(path);
    const id = freeId(info.id);
    if (id !== info.id) {
      maps.forget(info.id);
      maps.register(id, file);
    }
    const st = await stat(join(cfgDir.dir, 'maps', file));
    const { id: _i, name: _n, ...meta } = info;
    store.saveMapInfo(`${join(cfgDir.dir, 'maps', file)}:${st.size}:${st.mtimeMs}`, meta);
    const layers = [...config.layers];
    layers.splice(layers.findIndex((l) => l.type === 'heatmap') + 1, 0, { id, type: 'file', name: info.name, file: `maps/${file}`, on: true, opacity: 1 });
    await writeLayers(layers);
    return { ...info, id };
  });
  handle('addMapPath', addMap);
  handle('pickMap', async (): Promise<Result<MapInfo | null>> => {
    const r = await dialog.showOpenDialog(win!, { title: 'Add map', properties: ['openFile'], filters: [{ name: 'Maps', extensions: ['pmtiles', 'mbtiles', 'zip'] }] });
    return r.canceled || !r.filePaths[0] ? { ok: true, value: null } : addMap(r.filePaths[0]);
  });
  handle('renameMap', (id: unknown, name: unknown) => result(async () => {
    const n = typeof name === 'string' ? name.trim().slice(0, 100) : '';
    if (!n) throw new Error('A map needs a name.');
    if (!config.layers.some((l) => l.id === id)) throw new Error('Unknown map.');
    await writeLayers(config.layers.map((l) => (l.id === id ? { ...l, name: n } : l)));
  }));
  handle('removeMap', (id: unknown) => result(async () => {
    const l = config.layers.find((x) => x.id === id);
    if (!l || l.type !== 'file') throw new Error('Unknown map.');
    await writeLayers(config.layers.filter((x) => x !== l));
    // Keep the file if another layer still uses it.
    if (config.layers.some((x) => x.type === 'file' && x.file === l.file)) maps.forget(l.id);
    else await maps.remove(l.id).then(() => rm(join(cfgDir.dir, l.file), { force: true }));
  }));
  handle('addZone', (z: Required<CircleEdit>) => result(async () => {
    await cfgDir.write(APP_ZONES, addCircle(await cfgDir.read(APP_ZONES), { name: z?.name, center: z?.center, radius: z?.radius }));
    await reload();
  }));
  handle('editZone', (id: unknown, e: CircleEdit) => result(async () => {
    const at = appZone(id);
    await cfgDir.write(APP_ZONES, editCircle(await cfgDir.read(APP_ZONES), at, { name: e?.name, center: e?.center, radius: e?.radius }));
    await reload();
  }));
  handle('removeZone', (id: unknown) => result(async () => {
    const at = appZone(id);
    await cfgDir.write(APP_ZONES, removeZone(await cfgDir.read(APP_ZONES), at));
    await reload();
  }));
  handle('pickConfigDir', () => result(async () => {
    if (envDir) throw new Error('The TRAIL_CONFIG variable chooses the config folder, so it cannot be changed here.');
    const r = await dialog.showOpenDialog(win!, { title: 'Use config folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return false;
    store.set('configDir', r.filePaths[0]);
    await openConfig();
    return true;
  }));
  handle('useDefaultConfigDir', () => result(async () => {
    if (envDir) throw new Error('The TRAIL_CONFIG variable chooses the config folder, so it cannot be changed here.');
    store.set('configDir', null);
    await openConfig();
  }));
  handle('openConfigDir', () => void shell.openPath(cfgDir.dir));
  handle('getSaved', (): Saved => ({ view: store.get('view'), focus: store.get('focus'), showZones: store.get<boolean>('showZones') ?? true }));
  handle('saveView', (v: View) => {
    if (Array.isArray(v?.center) && v.center.length === 2 && [...v.center, v.zoom].every(Number.isFinite)) store.set('view', { center: v.center, zoom: v.zoom });
  });
  handle('saveShowZones', (on: unknown) => {
    if (typeof on === 'boolean') store.set('showZones', on);
  });

  // --- roads and trails ----------------------------------------------------------
  // Areas are listed in areas.json. Their road data is shared in osm.db, so it is
  // downloaded once, whichever areas use it.
  handle('getAreas', (): AreaView[] => areas.view());
  handle('getAreaRoads', (id: unknown) => result(() => {
    const c = typeof id === 'string' ? areas.roadsOf(id) : null;
    return c ? { version: c.version, roads: c.roads } : { version: 0, roads: [] };
  }));
  // One change to areas.json at a time, each from the file as it is now.
  let areaWrites: Promise<unknown> = Promise.resolve();
  const editAreas = (fn: (list: Area[]) => Area[]) => {
    const next = areaWrites.then(async () => {
      await loading;
      if (problems.some((p) => p.file === AREAS_FILE)) throw new Error(`${AREAS_FILE} has a problem, so the app will not change it. Fix it in the Customize screen's list first.`);
      const list = fn(config.areas);
      await cfgDir.write(AREAS_FILE, areasText(list, await cfgDir.read(AREAS_FILE)));
      await reload();
    });
    areaWrites = next.catch(() => {});
    return next;
  };
  handle('addArea', (a: { center?: unknown; radius?: unknown; name?: unknown }) => result(async () => {
    const edit = { center: a?.center, radius: a?.radius, name: typeof a?.name === 'string' && a.name.trim() ? a.name.trim() : null } as AreaEdit;
    if (edit.center === undefined || edit.radius === undefined) throw new Error('An area needs a place and a size.');
    checkAreaEdit(edit);
    let id = '';
    await editAreas((list) => {
      id = newAreaId(list);
      return [...list, { id, name: edit.name ?? null, center: edit.center!, radius: Math.round(edit.radius!), on: true, hide: [] }];
    });
    return id;
  }));
  handle('editArea', (id: unknown, e: unknown) => result(async () => {
    const edit = (e ?? {}) as AreaEdit;
    checkAreaEdit(edit);
    const clean: AreaEdit = {};
    if (edit.name !== undefined) clean.name = edit.name?.trim() || null;
    if (edit.on !== undefined) clean.on = edit.on;
    if (edit.hide !== undefined) clean.hide = [...new Set(edit.hide)];
    if (edit.center !== undefined) clean.center = edit.center;
    if (edit.radius !== undefined) clean.radius = Math.round(edit.radius);
    await editAreas((list) => {
      if (!list.some((a) => a.id === id)) throw new Error('That area is no longer in areas.json.');
      return list.map((a) => (a.id === id ? { ...a, ...clean } : a));
    });
  }));
  handle('removeArea', (id: unknown) => result(async () => {
    await editAreas((list) => {
      if (!list.some((a) => a.id === id)) throw new Error('That area is no longer in areas.json.');
      return list.filter((a) => a.id !== id);
    });
    const n = areas.prune();
    if (n) console.log(`Dropped ${n} roads no area uses.`);
  }));
  handle('retryArea', (id: unknown) => result(() => {
    if (typeof id === 'string') areas.retry(id);
  }));

  // --- trail:// ---------------------------------------------------------------
  const ok = (body: BodyInit | null, type: string, extra: Record<string, string> = {}) =>
    new Response(body, { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', ...extra } });
  const none = (status = 404) => new Response(null, { status, headers: { 'Access-Control-Allow-Origin': '*' } });
  async function file(base: string, path: string, extra?: Record<string, string>) {
    const full = normalize(join(base, path));
    if (!full.startsWith(base + sep)) return none(403);
    try {
      return ok(await readFile(full) as unknown as BodyInit, MIME[extname(full)] ?? 'application/octet-stream', extra);
    } catch {
      return none();
    }
  }
  protocol.handle('trail', async (req) => {
    const u = new URL(req.url);
    let path: string;
    try {
      path = decodeURIComponent(u.pathname).slice(1);
    } catch {
      return none(400);
    }
    if (path.includes('\0')) return none(400);
    if (u.host === 'app' && devServer) {
      try {
        const r = await net.fetch(`${devServer}${u.pathname}${u.search}`, { headers: { Accept: req.headers.get('accept') ?? '*/*' }, bypassCustomProtocolHandlers: true });
        const headers = new Headers({ 'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream', 'Content-Security-Policy': csp(config.layers), 'Cache-Control': 'no-store' });
        return new Response(await r.arrayBuffer(), { status: r.status, headers });
      } catch {
        return none(502);
      }
    }
    if (u.host === 'app') return file(uiDir, path || 'index.html', { 'Content-Security-Policy': csp(config.layers), 'Referrer-Policy': 'no-referrer' });
    if (u.host === 'styles' || u.host === 'sprites') return file(join(resources, u.host), path);
    if (u.host === 'heatmap') {
      try {
        return ok(await readFile(heatFile) as unknown as BodyInit, 'application/json', { 'Cache-Control': 'no-store' });
      } catch {
        return ok('{"type":"FeatureCollection","features":[]}', 'application/json', { 'Cache-Control': 'no-store' });
      }
    }
    if (u.host === 'fonts') {
      const r = await file(join(resources, 'fonts'), path);
      if (r.ok) return r;
      // Scripts we do not bundle come from the default map's font server.
      const m = path.match(/^noto_sans_(regular|bold|regular_italic)\/(\d{1,5}-\d{1,5})\.pbf$/);
      if (!m) return none();
      const name = { regular: 'Regular', bold: 'Bold', regular_italic: 'Italic' }[m[1]!];
      try {
        const x = await net.fetch(`https://tiles.openfreemap.org/fonts/Noto%20Sans%20${name}/${m[2]}.pbf`);
        if (x.ok) return ok(await x.arrayBuffer(), 'application/x-protobuf');
      } catch {}
      return ok(new Uint8Array(0), 'application/x-protobuf');
    }
    if (u.host === 'maps') {
      const m = path.match(/^([a-z0-9_-]{1,64})\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})$/);
      if (!m) return none(400);
      try {
        const t = await maps.tile(m[1]!, Number(m[2]), Number(m[3]), Number(m[4]));
        return t ? ok(t.data as unknown as BodyInit, t.type) : none(204);
      } catch (e) {
        console.error('Map tile failed:', e);
        return none(204);
      }
    }
    return none();
  });

  // --- window -------------------------------------------------------------------
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (d, cb) =>
    cb({ requestHeaders: { ...d.requestHeaders, 'User-Agent': `TrailExplorer/${app.getVersion()}` } }));

  function openWindow() {
    win = new BrowserWindow({
      width: 1280, height: 820, minWidth: 720, minHeight: 480, title: appName, backgroundColor: '#ffffff',
      webPreferences: { preload: join(here, '..', 'preload', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => {
      if (!e.url.startsWith('trail://app/')) {
        e.preventDefault();
        if (e.url.startsWith('https://')) void shell.openExternal(e.url);
      }
    });
    win.on('closed', () => (win = null));
    void win.loadURL('trail://app/index.html');
  }
  app.on('activate', () => {
    if (!win) openWindow();
  });
  app.on('second-instance', () => win?.focus());
  app.on('window-all-closed', () => app.quit());
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    stopWatching();
    void Promise.race([sync.stop(), new Promise((r) => setTimeout(r, 2000))]).then(async () => {
      if (timer) clearTimeout(timer);
      if (areasTimer) clearTimeout(areasTimer);
      areas.stop();
      osm.close();
      await maps.close();
      worker?.kill();
      store.close();
      app.quit();
    });
  });

  void Promise.all([keyFile.exists(), openConfig().catch((e) => console.error('Could not open the config folder:', e))]).then(([has]) => {
    hasKey = has;
    openWindow();
    if (has) sync.start();
    // In development, redraw on every start so heatmap changes show.
    if ((!version || devServer) && store.counts().done && !building) void buildHeatmap();
    if (devServer) {
      let t: NodeJS.Timeout | undefined;
      watch(resources, { recursive: true }, () => {
        clearTimeout(t);
        t = setTimeout(() => win?.webContents.reload(), 200);
      });
    }
  });
}

// Not in hot reload: a restart overlaps with the old copy closing, and an app that
// fails to get the lock once never becomes ready. The dev server's fixed port
// already stops two sessions running.
if (devServer || app.requestSingleInstanceLock()) void app.whenReady().then(start);
else app.quit();
