import { mkdirSync, watch } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, utilityProcess, type UtilityProcess } from 'electron';
import type { Bounds, LayerState, MapInfo, Result, Saved, Status, View } from '../core/api.ts';
import { Busy, Garmin, GARMIN, KeyRejected, Offline } from './garmin.ts';
import { KeyFile } from './key.ts';
import { Maps } from './maps.ts';
import { Store } from './store.ts';
import { Sync } from './sync.ts';

const root = app.getAppPath();
const here = join(root, 'out', 'main');
const resources = app.isPackaged ? join(process.resourcesPath, 'resources') : join(root, 'resources');
const uiDir = join(here, '..', 'ui');

// Anything not packaged is a development copy. It has its own data folder and
// Keychain entry, so it can run beside the real app and never touches its rides or key.
const appName = app.isPackaged ? 'Trail Explorer' : 'Trail Explorer Dev';
app.setName(appName);
/** Address of the hot reload server under `npm run dev`, otherwise null. */
const devServer = !app.isPackaged && /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.ELECTRON_RENDERER_URL ?? '') ? process.env.ELECTRON_RENDERER_URL! : null;
// Test hooks. They do nothing in the packaged app.
const test = app.isPackaged ? {} : { data: process.env.TRAIL_TEST_DATA, garmin: process.env.TRAIL_TEST_GARMIN };
app.setPath('userData', test.data ?? join(app.getPath('appData'), appName));
const garminBase = test.garmin?.startsWith('http://127.0.0.1:') ? test.garmin : GARMIN;

protocol.registerSchemesAsPrivileged([
  { scheme: 'trail', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const MAP_HOSTS = 'https://tiles.openfreemap.org https://*.tile.opentopomap.org https://www.ign.es';
const CSP = [
  "default-src 'none'",
  // Hot reload adds an inline script and a socket. Never in the packaged app.
  `script-src 'self'${devServer ? " 'unsafe-inline'" : ''}`,
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' trail: data: blob: ${MAP_HOSTS}`,
  `connect-src 'self' trail: blob: ${MAP_HOSTS}${devServer ? ` ${devServer.replace('http', 'ws')}` : ''}`,
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
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
  const keyFile = new KeyFile(join(data, 'key.bin'));
  const maps = new Maps(join(data, 'maps'));
  for (const m of store.maps()) maps.register(m.id, m.file);

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
  async function buildHeatmap() {
    if (building) {
      buildAgain = true;
      return;
    }
    building = true;
    changed();
    try {
      do {
        buildAgain = false;
        const out = await runJob<{ json: string; focus: Bounds | null }>('heatmap', store.tracks());
        await writeFile(`${heatFile}.part`, out.json);
        await rename(`${heatFile}.part`, heatFile);
        store.set('focus', out.focus);
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
  handle('listMaps', () => store.maps().map((m) => m.info));
  const addMap = (path: unknown) => result(async (): Promise<MapInfo> => {
    if (typeof path !== 'string' || !path) throw new Error('That file could not be opened.');
    const { file, info } = await maps.add(path);
    store.saveMap(file, info);
    return info;
  });
  handle('addMapPath', addMap);
  handle('pickMap', async (): Promise<Result<MapInfo | null>> => {
    const r = await dialog.showOpenDialog(win!, { title: 'Add map', properties: ['openFile'], filters: [{ name: 'Maps', extensions: ['pmtiles', 'mbtiles', 'zip'] }] });
    return r.canceled || !r.filePaths[0] ? { ok: true, value: null } : addMap(r.filePaths[0]);
  });
  handle('renameMap', (id: unknown, name: unknown) => result(() => {
    const m = store.maps().find((x) => x.id === id);
    const n = typeof name === 'string' ? name.trim().slice(0, 100) : '';
    if (!m || !n) throw new Error('A map needs a name.');
    store.saveMap(m.file, { ...m.info, name: n });
  }));
  handle('removeMap', (id: unknown) => result(async () => {
    if (!isId(id)) throw new Error('Unknown map.');
    store.removeMap(id);
    await maps.remove(id);
  }));
  handle('getSaved', (): Saved => ({ layers: store.get('layers'), view: store.get('view'), focus: store.get('focus') }));
  handle('saveLayers', (ls: unknown) => {
    if (!Array.isArray(ls) || ls.length > 500) return;
    store.set('layers', ls.filter((l): l is LayerState => isId(l?.id) && typeof l.on === 'boolean' && Number.isFinite(l.opacity))
      .map((l) => ({ id: l.id, on: l.on, opacity: Math.max(0, Math.min(1, l.opacity)) })));
  });
  handle('saveView', (v: View) => {
    if (Array.isArray(v?.center) && v.center.length === 2 && [...v.center, v.zoom].every(Number.isFinite)) store.set('view', { center: v.center, zoom: v.zoom });
  });

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
        const headers = new Headers({ 'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
        return new Response(await r.arrayBuffer(), { status: r.status, headers });
      } catch {
        return none(502);
      }
    }
    if (u.host === 'app') return file(uiDir, path || 'index.html', { 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' });
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
      const m = path.match(/^([\w-]+)\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})$/);
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
    void Promise.race([sync.stop(), new Promise((r) => setTimeout(r, 2000))]).then(async () => {
      if (timer) clearTimeout(timer);
      await maps.close();
      worker?.kill();
      store.close();
      app.quit();
    });
  });

  void keyFile.exists().then((has) => {
    hasKey = has;
    openWindow();
    if (has) sync.start();
    // In development, redraw on every start so heatmap changes show.
    if ((!version || devServer) && store.counts().done) void buildHeatmap();
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
