import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AreasState, AreaView, Backup, Bounds, ConfigState, GroupView, LayerState, MapInfo, Saved, Status, View } from '../core/api.ts';
import { layerState, type Config, type LayerDef } from '../core/config.ts';
import type { AreaEdit, GroupEdit } from '../core/areas.ts';
import { KINDS, type Road, type RoadKind } from '../core/roads.ts';
import { MIN_AREA, MIN_SIDE, shapeProblem, type Shape } from '../core/shapes.ts';
import { asset, trail } from './api.ts';
import { Customize } from './Customize.tsx';
import { buildStyle, KEY_SEP, type Bundled, type StyleArea } from './mapstyle.ts';
import { MapView } from './MapView.tsx';
import { Planner } from './Planner.tsx';
import { RoutesScreen } from './RoutesScreen.tsx';
import { Help, KeyForm, Settings } from './Screens.tsx';
import { RoadsPanel, sizeLabel } from './Roads.tsx';
import { NarrowContext, useMeasureNarrow, useTouch } from './narrow.ts';
import { Parts, Sidebar, type Props as SidebarProps } from './Sidebar.tsx';

/** What fills the window. layers, areas and more are the phone layout's sheets; the desktop shows them in the sidebar. */
export type Screen = 'map' | 'routes' | 'customize' | 'settings' | 'help' | 'layers' | 'areas' | 'more';
const PHONE_ONLY: Screen[] = ['layers', 'areas', 'more'];
const TITLES: Record<Screen, string> = { map: 'Map', routes: 'Saved routes', customize: 'Customize', settings: 'Settings', help: 'Help', layers: 'Rides and layers', areas: 'Areas', more: 'More' };
/** The phone layout's tabs: screen, label and icon. */
const TABS: [Screen, string, string][] = [['map', 'Map', '◎'], ['layers', 'Layers', '≋'], ['areas', 'Areas', '◯'], ['routes', 'Routes', '↝'], ['more', 'More', '⋯']];
const MORE_NOTES: Partial<Record<Screen, string>> = { customize: 'Colours, layers, outline, and your config as a .zip', settings: 'Ride data and version', help: 'How everything works' };
/** Clicking the map places a new zone, or moves one. */
export type Placing = { kind: 'new' } | { kind: 'move'; id: string } | null;

const NEW_ZONE_RADIUS = 300;

/** An edit still being saved, shown at once. */
type Pending = { kind: 'area'; id: string; edit: AreaEdit | 'remove' } | { kind: 'group'; id: string; edit: GroupEdit | 'remove' | 'remove-all' };

/** The areas and groups with edits still being saved, and each group's on and hide worked out again from its areas. */
function applyPending(state: AreasState, pending: Iterable<Pending>): AreasState {
  let { areas, groups } = state;
  for (const p of pending) {
    if (p.kind === 'area') {
      areas = p.edit === 'remove' ? areas.filter((a) => a.id !== p.id) : areas.map((a) => (a.id === p.id ? { ...a, ...(p.edit as AreaEdit) } : a));
    } else if (p.edit === 'remove' || p.edit === 'remove-all') {
      const all = p.edit === 'remove-all';
      areas = all ? areas.filter((a) => a.group !== p.id) : areas.map((a) => (a.group === p.id ? { ...a, group: null } : a));
      groups = groups.filter((g) => g.id !== p.id);
    } else {
      const e = p.edit;
      groups = groups.map((g) => (g.id === p.id ? { ...g, ...e } : g));
    }
  }
  groups = groups.flatMap((g) => {
    const ms = areas.filter((a) => a.group === g.id);
    if (!ms.length) return [];
    const hide = KINDS.map((k) => k.kind).filter((k) => ms.every((m) => m.hide.includes(k)));
    return [{ ...g, members: ms.map((m) => m.id), on: ms.every((m) => m.on), hide }];
  });
  return { areas, groups };
}

/** The config's layers in the order, visibility and opacity shown, which may be a moment ahead of the file. */
function withStates(config: Config, states: LayerState[]): Config {
  const byId = new Map(states.map((s, i) => [s.id, { s, i }]));
  const layers = config.layers
    .map((l) => ({ l, at: byId.get(l.id) }))
    .sort((a, b) => (a.at?.i ?? 1e9) - (b.at?.i ?? 1e9))
    .map(({ l, at }) => (at ? ({ ...l, on: at.s.on, opacity: at.s.opacity, ...(l.type === 'heatmap' || l.type === 'roads' ? { width: at.s.width } : {}) } as LayerDef) : l));
  return { ...config, layers };
}

/** Changes kept only in a browser: ask for a file copy once there are 10, or the oldest is a day old. */
export const remind = (b: Backup) => b.unsaved > 0 && (b.unsaved >= 10 || (b.since !== null && Date.now() - Date.parse(b.since) >= 86_400_000));

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [cfg, setCfg] = useState<ConfigState | null>(null);
  const [layers, setLayers] = useState<LayerState[]>([]);
  const [bundled, setBundled] = useState<Bundled | null>(null);
  const [screen, setScreen] = useState<Screen>('map');
  const [measure, narrow] = useMeasureNarrow();
  const touch = useTouch();
  const tap = touch ? 'Tap' : 'Click';
  // The phone layout's sheets are in the sidebar on a wider screen.
  useEffect(() => {
    if (!narrow && PHONE_ONLY.includes(screen)) setScreen('map');
  }, [narrow, screen]);
  const wrap = (x: ReactNode) => (
    <div className={`te${narrow ? ' narrow' : ''}`} ref={measure}>
      <NarrowContext.Provider value={narrow}>{x}</NarrowContext.Provider>
    </div>
  );
  /** The route planner fills the window in place of everything else. */
  const [planning, setPlanning] = useState(false);
  const [goTo, setGoTo] = useState<{ bounds: Bounds | View; n: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [showZones, setShowZones] = useState(true);
  const [placing, setPlacing] = useState<Placing>(null);
  const [drawing, setDrawing] = useState(false);
  const [drawShape, setDrawShape] = useState<Shape['kind']>('circle');
  /** The shape so far, once the first click is made. */
  const [sketch, setDrawn] = useState<Shape | null>(null);
  const [drawGroup, setDrawGroup] = useState<string | null>(null);
  const [got, setGot] = useState<AreasState>({ areas: [], groups: [] });
  const [pendingNo, setPendingNo] = useState(0);
  const [roads, setRoads] = useState<Record<string, { version: number; roads: Road[] }>>({});
  /** The area whose roads are listed over the map. */
  const [listed, setListed] = useState<string | null>(null);
  /** The selected road, as area id + KEY_SEP + road key. */
  const [selected, setSelected] = useState<string | null>(null);
  const asked = useRef(new Map<string, number>());
  /** Area and group edits still being saved. Kept over updates from the app until they are. */
  const pending = useRef(new Map<number, Pending>());
  const editNo = useRef(0);
  const gotAreas = useCallback((s: AreasState) => setGot(s), []);
  const { areas, groups } = useMemo(() => applyPending(got, pending.current.values()), [got, pendingNo]);

  const config = (c: ConfigState) => {
    setCfg(c);
    setLayers(c.config.layers.map(layerState));
  };
  useEffect(() => {
    const json = (u: string) => fetch(u).then((r) => r.json());
    void Promise.all([trail.getStatus(), trail.getSaved(), trail.getConfig(), json(asset('styles', 'liberty.json')), json(asset('styles', 'shortbread.json'))])
      .then(([st, sv, c, liberty, shortbread]) => {
        config(c);
        setBundled({ liberty, shortbread });
        setSaved(sv);
        setView(sv.view);
        setShowZones(sv.showZones);
        setStatus(st);
      });
    void trail.getAreas().then(gotAreas);
    const offAreas = trail.onAreas(gotAreas);
    const offStatus = trail.onStatus(setStatus);
    const offConfig = trail.onConfig(config);
    return () => {
      offAreas();
      offStatus();
      offConfig();
    };
  }, []);
  // Fetch the roads of each area, and each joined group, once it is ready, and again when they change.
  useEffect(() => {
    for (const a of [...areas, ...groups.filter((g) => g.joined)]) {
      if (a.state !== 'ready' || roads[a.id]?.version === a.version || asked.current.get(a.id) === a.version) continue;
      asked.current.set(a.id, a.version);
      void trail.getAreaRoads(a.id).then((r) => {
        if (r.ok && r.value.version) setRoads((x) => ({ ...x, [a.id]: r.value }));
      });
    }
    const ids = new Set([...areas.map((a) => a.id), ...groups.filter((g) => g.joined).map((g) => g.id)]);
    if (Object.keys(roads).some((id) => !ids.has(id))) setRoads((x) => Object.fromEntries(Object.entries(x).filter(([id]) => ids.has(id))));
    // An area just drawn is listed before it arrives here, so `listed` is not cleared: the panel hides itself.
  }, [areas, groups, roads]);
  useEffect(() => {
    if (!placing && !drawing) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPlacing(null);
      setDrawing(false);
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [placing, drawing]);

  // Sliders move many times a second, so the file is written once they stop.
  const saveTimer = useRef(0);
  const change = useCallback((ls: LayerState[]) => {
    setLayers(ls);
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const r = await trail.saveLayers(ls);
      if (!r.ok) setNotice(r.error);
    }, 400);
  }, []);
  const go = useCallback((bounds: Bounds | View) => setGoTo((g) => ({ bounds, n: (g?.n ?? 0) + 1 })), []);
  const onView = useCallback((v: View) => {
    setView(v);
    void trail.saveView(v);
  }, []);
  const toggleZones = (on: boolean) => {
    setShowZones(on);
    void trail.saveShowZones(on);
  };
  const place = async (at: [number, number]) => {
    const p = placing;
    setPlacing(null);
    if (!p || !cfg) return;
    const names = new Set(cfg.config.zones.map((z) => z.name));
    let n = cfg.config.zones.length + 1;
    while (names.has(`Zone ${n}`)) n++;
    const r = p.kind === 'new'
      ? await trail.addZone({ name: `Zone ${n}`, center: at, radius: NEW_ZONE_RADIUS })
      : await trail.editZone(p.id, { center: at });
    if (!r.ok) setNotice(r.error);
    else if (!showZones) toggleZones(true);
  };

  /** Starts drawing a circle or a rectangle, for a group or on its own. */
  const startDrawing = (shape: Shape['kind'], group: string | null = null) => {
    setScreen('map');
    setPlacing(null);
    setDrawn(null);
    setDrawShape(shape);
    setDrawGroup(group);
    setDrawing(true);
  };
  const drawn = async (shape: Shape) => {
    if (shapeProblem(shape)) {
      setDrawn(null);
      setNotice(shape.kind === 'circle'
        ? `Make the circle at least ${MIN_AREA} m from its centre to its edge. Click the centre again.`
        : `Make each side of the rectangle at least ${MIN_SIDE} m. Click the first corner again.`);
      return;
    }
    setNotice(null);
    setDrawing(false);
    const group = groups.find((g) => g.id === drawGroup) ?? null;
    const r = await trail.addArea({ shape, group: group?.id ?? null });
    if (!r.ok) setNotice(r.error);
    else {
      setSelected(null);
      // An area added to a joined group is part of the group's one list.
      setListed(group?.joined ? group.id : r.value);
    }
  };
  const report = async (r: Promise<{ ok: boolean; error?: string }>) => {
    const x = await r;
    if (!x.ok) setNotice(x.error ?? 'Something went wrong.');
    return x.ok;
  };
  /** Shows an edit at once, saves it, then shows what was saved. */
  const pend = (p: Pending, save: Promise<{ ok: boolean; error?: string }>) => {
    const n = ++editNo.current;
    pending.current.set(n, p);
    setPendingNo(n);
    void report(save).finally(() => {
      // Shown as it was until the saved list arrives, so nothing flicks back meanwhile.
      pending.current.delete(n);
      void trail.getAreas().then(gotAreas);
    });
  };
  const editArea = (id: string, edit: AreaEdit | 'remove') => {
    if (edit === 'remove' && listed === id) setListed(null);
    pend({ kind: 'area', id, edit }, edit === 'remove' ? trail.removeArea(id) : trail.editArea(id, edit));
  };
  const editGroup = (id: string, edit: GroupEdit | 'remove' | 'remove-all') => {
    const g = groups.find((x) => x.id === id);
    if (typeof edit !== 'string' && edit.joined !== undefined && g) {
      // The list switches between the group and its areas.
      if (edit.joined && g.members.includes(listed ?? '')) setListed(id);
      if (!edit.joined && listed === id) setListed(null);
      setSelected(null);
    }
    if (typeof edit === 'string' && (listed === id || (edit === 'remove-all' && g?.members.includes(listed ?? '')))) setListed(null);
    pend({ kind: 'group', id, edit }, typeof edit === 'string' ? trail.removeGroup(id, edit === 'remove-all') : trail.editGroup(id, edit));
  };
  /** Turns a group's areas on or off, or shows and hides a kind in all of them. */
  const editMembers = (g: GroupView, edit: { on?: boolean; hide?: RoadKind[] }) => {
    for (const m of g.members) editArea(m, edit);
  };

  const addMap = async (file?: File) => {
    if (adding) return;
    setAdding(true);
    setNotice(null);
    try {
      const r: { ok: true; value: MapInfo | null } | { ok: false; error: string } = file ? await trail.addDroppedMap(file) : await trail.pickMap();
      if (!r.ok) setNotice(r.error);
      else if (r.value) {
        setScreen('map');
        go(r.value.bounds);
      }
    } finally {
      setAdding(false);
    }
  };
  const goToRides = async () => {
    const f = (await trail.getSaved()).focus;
    setScreen('map');
    if (f) go(f);
    else setNotice('There are no rides on the map yet.');
  };

  const hv = status?.heatmapVersion ?? 0;
  const rides = status?.features.rides ?? true;
  const shown = useMemo(() => (cfg ? withStates(cfg.config, layers) : null), [cfg, layers]);
  const styleAreas = useMemo((): StyleArea[] => {
    const joined = new Map(groups.filter((g) => g.joined).map((g) => [g.id, g]));
    const out: StyleArea[] = [];
    for (const a of areas) {
      const g = a.group ? joined.get(a.group) : undefined;
      if (!g) {
        if (a.on) out.push({ id: a.id, shapes: [a.shape], ready: a.state === 'ready', roads: (roads[a.id]?.roads ?? []).filter((r) => !a.hide.includes(r.kind)) });
        continue;
      }
      // A joined group is drawn once, where its first area is.
      if (g.members[0] !== a.id) continue;
      const on = areas.filter((m) => m.group === g.id && m.on);
      if (on.length) out.push({ id: g.id, shapes: on.map((m) => m.shape), ready: g.state === 'ready', roads: (roads[g.id]?.roads ?? []).filter((r) => !g.hide.includes(r.kind)) });
    }
    return out;
  }, [areas, groups, roads]);
  const style = useMemo(
    () => (bundled && cfg && shown ? buildStyle({ config: shown, maps: cfg.maps, bundled, heatVersion: hv, showZones: showZones && rides, drawing, areas: styleAreas, selected, rides }) : null),
    [shown, cfg, bundled, hv, showZones, drawing, styleAreas, selected, rides],
  );
  const listedGroup = groups.find((g) => g.id === listed && g.joined) ?? null;
  const listedArea: AreaView | GroupView | null = listedGroup ?? areas.find((a) => a.id === listed) ?? null;
  const pick = (key: string | null) => {
    setSelected(key);
    if (key) setListed(key.slice(0, key.indexOf(KEY_SEP)));
  };
  if (!status || !saved || !cfg || !shown || !style) return wrap(null);

  if (status.features.garmin && !status.hasKey && status.sync.total === 0 && screen === 'map') {
    return wrap(
      <main className="page">
        <h1>Trail Explorer</h1>
        <p>See everywhere you have ridden on one map. To start, the app needs your Garmin personal API key.</p>
        <KeyForm />
      </main>,
    );
  }

  if (planning) {
    return wrap(
      <Planner config={shown} maps={cfg.maps} bundled={bundled!} areas={areas} groups={groups} rides={status.features.rides}
        exit={() => { setPlanning(false); setScreen('map'); }} showRoutes={() => { setPlanning(false); setScreen('routes'); }} />,
    );
  }

  const daysLeft = status.keyExpires ? Math.ceil((Date.parse(status.keyExpires) - Date.now()) / 86_400_000) : null;
  const m = shown.map;
  const onMap = screen === 'map';
  const sidebar: SidebarProps = {
    status, cfg, config: shown, adding, screen, setScreen, change, go, goToRides, addMap: () => void addMap(), notice: setNotice,
    showZones, setShowZones: toggleZones, placing, setPlacing: (p) => { setScreen('map'); setDrawing(false); setPlacing(p); },
    drawing, drawShape, drawGroup, startDrawing, areas, groups, editArea, editGroup, editMembers,
    openPlanner: () => { setDrawing(false); setPlacing(null); setPlanning(true); },
    listArea: (id) => { setScreen('map'); setSelected(null); setListed(id); },
  };
  /** Notices about the whole app. On a phone they are shown over the map only. */
  const appNotices = (
    <>
      {status.keyProblem && screen !== 'settings' && (
        <div className="notice">{status.keyProblem} Your map still works. <button onClick={() => setScreen('settings')}>Enter a new key</button></div>
      )}
      {!status.keyProblem && status.hasKey && daysLeft !== null && daysLeft <= 14 && screen !== 'settings' && (
        <div className="notice">
          Your Garmin key {daysLeft <= 0 ? 'has expired' : `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}. <button onClick={() => setScreen('settings')}>Replace it</button>
        </div>
      )}
      {status.backup && screen !== 'customize' && remind(status.backup) && (
        <div className="notice" role="status">
          {status.backup.unsaved} change{status.backup.unsaved === 1 ? '' : 's'} to your config {status.backup.unsaved === 1 ? 'is' : 'are'} only in this browser,
          which can lose them. Save a copy to a file.{' '}
          <button onClick={() => void trail.exportConfig()}>Export config</button>{' '}
          <button onClick={() => setScreen('customize')}>More</button>
        </div>
      )}
      {cfg.problems.length > 0 && screen !== 'customize' && (
        <div className="notice">
          The config folder has {cfg.problems.length} problem{cfg.problems.length === 1 ? '' : 's'}. <button onClick={() => setScreen('customize')}>Show</button>
        </div>
      )}
    </>
  );
  /** What clicking the map does now, if anything. */
  const mapNotices = onMap && (
    <>
      {placing && (
        <div className="notice" role="status">
          {tap} the map where the zone should {placing.kind === 'new' ? 'go' : 'move to'}. <button onClick={() => setPlacing(null)}>Cancel</button>
        </div>
      )}
      {drawing && (
        <div className="notice" role="status">
          {/* A finger can't hover, so there is no size to show until the second tap. */}
          {drawShape === 'circle'
            ? (sketch ? (touch ? 'Now tap the edge of the area to finish.' : `${sizeLabel(sketch)}. Click again to finish.`) : `${tap} the centre of the area to search.`)
            : (sketch ? (touch ? 'Now tap the opposite corner to finish.' : `${sizeLabel(sketch)}. Click the opposite corner to finish.`) : `${tap} one corner of the area to search.`)}
          {drawGroup && ` It goes in ${groups.find((g) => g.id === drawGroup)?.name ?? 'the group'}.`}
          {' '}<button onClick={() => setDrawing(false)}>Cancel</button>
        </div>
      )}
    </>
  );
  const alert = notice && <div className="notice" role="alert">{notice} <button onClick={() => setNotice(null)}>Close</button></div>;
  const mapArea = (
    <div className="map-wrap">
      <MapView
        style={style} view={view} startView={m.view} focus={saved.focus} minZoom={m.minZoom} maxZoom={m.maxZoom}
        placing={placing !== null} onPlace={(at) => void place(at)} locate={narrow}
        drawing={drawing} drawShape={drawShape} onDrawn={(s) => void drawn(s)} onDrawShape={setDrawn} onPickRoad={pick}
        goTo={goTo} onWent={() => setGoTo(null)} onView={onView} onTileError={setOffline}
      />
      {listedArea && (
        <RoadsPanel
          area={listedArea} roads={roads[listedArea.id]?.roads ?? null} report={report} go={go}
          setHide={(hide) => (listedGroup ? editMembers(listedGroup, { hide }) : editArea(listedArea.id, { hide }))}
          selected={selected?.startsWith(listedArea.id + KEY_SEP) ? selected.slice(listedArea.id.length + 1) : null}
          select={(k) => setSelected(k ? listedArea.id + KEY_SEP + k : null)}
          close={() => { setListed(null); setSelected(null); }}
        />
      )}
    </div>
  );
  const page = (s: Screen) => (
    <>
      {s === 'customize' && <Customize cfg={cfg} status={status} view={view} showOnMap={(v) => { setScreen('map'); go(v); }} />}
      {s === 'routes' && <RoutesScreen config={shown} maps={cfg.maps} bundled={bundled!} plan={() => setPlanning(true)} />}
      {s === 'settings' && <Settings status={status} />}
      {s === 'help' && <Help />}
    </>
  );
  const drop = {
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) void addMap(f);
    },
  };

  if (narrow) {
    const more = screen === 'more' || screen === 'customize' || screen === 'settings' || screen === 'help';
    const tab = more ? 'more' : screen;
    return wrap(
      <div className="app mobile" {...drop}>
        <div className="main">
          {mapArea}
          {onMap && (
            <div className="notices">
              {appNotices}
              {mapNotices}
              {offline && <div className="notice">{offline}</div>}
              {alert}
            </div>
          )}
          {!onMap && (
            <section className="sheet" aria-label={TITLES[screen]}>
              <header className="sheet-head">
                {more && screen !== 'more' && <button className="back" onClick={() => setScreen('more')}>‹ More</button>}
                <h1>{TITLES[screen]}</h1>
                <button className="done" onClick={() => setScreen('map')}>Done</button>
              </header>
              <div className="sheet-body">
                {alert}
                {screen === 'layers' && <div className="page"><Parts p={sidebar} show={['rides', 'layers', 'legend']} /></div>}
                {screen === 'areas' && <div className="page"><Parts p={sidebar} show={['areas', 'zones']} /></div>}
                {screen === 'more' && (
                  <div className="page">
                    <ul className="menu">
                      {(['customize', 'settings', 'help'] as const).map((s) => (
                        <li key={s}><button onClick={() => setScreen(s)}><span>{TITLES[s]}</span><span className="small">{MORE_NOTES[s]}</span></button></li>
                      ))}
                    </ul>
                    <p className="small">Trail Explorer {status.version}</p>
                  </div>
                )}
                {page(screen)}
              </div>
            </section>
          )}
        </div>
        <nav className="tabbar" aria-label="Main">
          {TABS.map(([t, label, icon]) => (
            <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => setScreen(tab === t && t !== 'map' ? 'map' : t)}>
              <span className="icon" aria-hidden="true">{icon}</span>{label}
            </button>
          ))}
        </nav>
      </div>,
    );
  }

  return wrap(
    <div className="app" {...drop}>
      <Sidebar {...sidebar} />
      <div className="main">
        <div className="notices">
          {appNotices}
          {mapNotices}
          {offline && <div className="notice">{offline}</div>}
          {alert}
        </div>
        {onMap && mapArea}
        {page(screen)}
      </div>
    </div>,
  );
}
