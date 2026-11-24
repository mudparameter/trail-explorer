import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AreaView, Bounds, ConfigState, LayerState, MapInfo, Saved, Status, View } from '../core/api.ts';
import { layerState, type Config, type LayerDef } from '../core/config.ts';
import type { AreaEdit } from '../core/areas.ts';
import { distance, MIN_AREA, type Road } from '../core/roads.ts';
import { trail } from './api.ts';
import { Customize } from './Customize.tsx';
import { buildStyle, KEY_SEP, type Bundled, type StyleArea } from './mapstyle.ts';
import { MapView } from './MapView.tsx';
import { Help, KeyForm, Settings } from './Screens.tsx';
import { RoadsPanel } from './Roads.tsx';
import { Sidebar } from './Sidebar.tsx';

export type Screen = 'map' | 'customize' | 'settings' | 'help';
/** Clicking the map places a new zone, or moves one. */
export type Placing = { kind: 'new' } | { kind: 'move'; id: string } | null;

const NEW_ZONE_RADIUS = 300;

/** The config's layers in the order, visibility and opacity shown, which may be a moment ahead of the file. */
function withStates(config: Config, states: LayerState[]): Config {
  const byId = new Map(states.map((s, i) => [s.id, { s, i }]));
  const layers = config.layers
    .map((l) => ({ l, at: byId.get(l.id) }))
    .sort((a, b) => (a.at?.i ?? 1e9) - (b.at?.i ?? 1e9))
    .map(({ l, at }) => (at ? ({ ...l, on: at.s.on, opacity: at.s.opacity, ...(l.type === 'heatmap' ? { width: at.s.width } : {}) } as LayerDef) : l));
  return { ...config, layers };
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [cfg, setCfg] = useState<ConfigState | null>(null);
  const [layers, setLayers] = useState<LayerState[]>([]);
  const [bundled, setBundled] = useState<Bundled | null>(null);
  const [screen, setScreen] = useState<Screen>('map');
  const [goTo, setGoTo] = useState<{ bounds: Bounds | View; n: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [showZones, setShowZones] = useState(true);
  const [placing, setPlacing] = useState<Placing>(null);
  const [drawing, setDrawing] = useState(false);
  const [drawRadius, setDrawRadius] = useState<number | null>(null);
  const [areas, setAreas] = useState<AreaView[]>([]);
  const [roads, setRoads] = useState<Record<string, { version: number; roads: Road[] }>>({});
  /** The area whose roads are listed over the map. */
  const [listed, setListed] = useState<string | null>(null);
  /** The selected road, as area id + KEY_SEP + road key. */
  const [selected, setSelected] = useState<string | null>(null);
  const asked = useRef(new Map<string, number>());
  /** Area edits and removals still being saved. Kept over updates from the app until they are. */
  const pending = useRef(new Map<number, { id: string; edit: AreaEdit | 'remove' }>());
  const editNo = useRef(0);
  const gotAreas = useCallback((list: AreaView[]) => {
    let out = list;
    for (const { id, edit } of pending.current.values()) {
      out = edit === 'remove' ? out.filter((a) => a.id !== id) : out.map((a) => (a.id === id ? { ...a, ...edit } : a));
    }
    setAreas(out);
  }, []);

  const config = (c: ConfigState) => {
    setCfg(c);
    setLayers(c.config.layers.map(layerState));
  };
  useEffect(() => {
    const json = (u: string) => fetch(u).then((r) => r.json());
    void Promise.all([trail.getStatus(), trail.getSaved(), trail.getConfig(), json('trail://styles/liberty.json'), json('trail://styles/shortbread.json')])
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
  // Fetch the roads of each area once it is ready, and again when they change.
  useEffect(() => {
    for (const a of areas) {
      if (a.state !== 'ready' || roads[a.id]?.version === a.version || asked.current.get(a.id) === a.version) continue;
      asked.current.set(a.id, a.version);
      void trail.getAreaRoads(a.id).then((r) => {
        if (r.ok && r.value.version) setRoads((x) => ({ ...x, [a.id]: r.value }));
      });
    }
    const ids = new Set(areas.map((a) => a.id));
    if (Object.keys(roads).some((id) => !ids.has(id))) setRoads((x) => Object.fromEntries(Object.entries(x).filter(([id]) => ids.has(id))));
    // An area just drawn is listed before it arrives here, so `listed` is not cleared: the panel hides itself.
  }, [areas, roads]);
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

  const startDrawing = () => {
    setScreen('map');
    setPlacing(null);
    setDrawRadius(null);
    setDrawing(true);
  };
  const drawn = async (center: [number, number], radius: number) => {
    if (radius < MIN_AREA) {
      setDrawRadius(null);
      setNotice(`Make the circle at least ${MIN_AREA} m across from its centre. Click the centre again.`);
      return;
    }
    setNotice(null);
    setDrawing(false);
    const r = await trail.addArea({ center, radius });
    if (!r.ok) setNotice(r.error);
    else {
      setSelected(null);
      setListed(r.value);
    }
  };
  const report = async (r: Promise<{ ok: boolean; error?: string }>) => {
    const x = await r;
    if (!x.ok) setNotice(x.error ?? 'Something went wrong.');
    return x.ok;
  };
  const editArea = (id: string, edit: AreaEdit | 'remove') => {
    const n = ++editNo.current;
    pending.current.set(n, { id, edit });
    setAreas((as) => (edit === 'remove' ? as.filter((a) => a.id !== id) : as.map((a) => (a.id === id ? { ...a, ...edit } : a))));
    if (edit === 'remove' && listed === id) setListed(null);
    void report(edit === 'remove' ? trail.removeArea(id) : trail.editArea(id, edit)).finally(() => {
      pending.current.delete(n);
      void trail.getAreas().then(gotAreas);
    });
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
  const shown = useMemo(() => (cfg ? withStates(cfg.config, layers) : null), [cfg, layers]);
  const styleAreas = useMemo(
    (): StyleArea[] => areas.filter((a) => a.on).map((a) => ({
      id: a.id, center: a.center, radius: a.radius, ready: a.state === 'ready',
      roads: (roads[a.id]?.roads ?? []).filter((r) => !a.hide.includes(r.kind)),
    })),
    [areas, roads],
  );
  const style = useMemo(
    () => (bundled && cfg && shown ? buildStyle({ config: shown, maps: cfg.maps, bundled, heatVersion: hv, showZones, drawing, areas: styleAreas, selected }) : null),
    [shown, cfg, bundled, hv, showZones, drawing, styleAreas, selected],
  );
  const listedArea = areas.find((a) => a.id === listed) ?? null;
  const pick = (key: string | null) => {
    setSelected(key);
    if (key) setListed(key.slice(0, key.indexOf(KEY_SEP)));
  };
  if (!status || !saved || !cfg || !shown || !style) return null;

  if (!status.hasKey && status.sync.total === 0 && screen === 'map') {
    return (
      <main className="page">
        <h1>Trail Explorer</h1>
        <p>See everywhere you have ridden on one map. To start, the app needs your Garmin personal API key.</p>
        <KeyForm />
      </main>
    );
  }

  const daysLeft = status.keyExpires ? Math.ceil((Date.parse(status.keyExpires) - Date.now()) / 86_400_000) : null;
  const m = shown.map;
  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) void addMap(f);
      }}
    >
      <Sidebar
        status={status} cfg={cfg} config={shown} adding={adding} screen={screen} setScreen={setScreen} change={change} go={go}
        goToRides={goToRides} addMap={() => void addMap()} notice={setNotice}
        showZones={showZones} setShowZones={toggleZones} placing={placing}
        setPlacing={(p) => { setScreen('map'); setDrawing(false); setPlacing(p); }}
        drawing={drawing} startDrawing={startDrawing} areas={areas} editArea={editArea}
        listArea={(id) => { setScreen('map'); setSelected(null); setListed(id); }}
      />
      <div className="main">
        {status.keyProblem && screen !== 'settings' && (
          <div className="notice">{status.keyProblem} Your map still works. <button onClick={() => setScreen('settings')}>Enter a new key</button></div>
        )}
        {!status.keyProblem && status.hasKey && daysLeft !== null && daysLeft <= 14 && screen !== 'settings' && (
          <div className="notice">
            Your Garmin key {daysLeft <= 0 ? 'has expired' : `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}. <button onClick={() => setScreen('settings')}>Replace it</button>
          </div>
        )}
        {cfg.problems.length > 0 && screen !== 'customize' && (
          <div className="notice">
            The config folder has {cfg.problems.length} problem{cfg.problems.length === 1 ? '' : 's'}. <button onClick={() => setScreen('customize')}>Show</button>
          </div>
        )}
        {placing && screen === 'map' && (
          <div className="notice" role="status">
            Click the map where the zone should {placing.kind === 'new' ? 'go' : 'move to'}. <button onClick={() => setPlacing(null)}>Cancel</button>
          </div>
        )}
        {drawing && screen === 'map' && (
          <div className="notice" role="status">
            {drawRadius === null ? 'Click the centre of the area to search.' : `Radius ${distance(drawRadius)}. Click again to finish.`}
            {' '}<button onClick={() => setDrawing(false)}>Cancel</button>
          </div>
        )}
        {offline && <div className="notice">{offline}</div>}
        {notice && <div className="notice" role="alert">{notice} <button onClick={() => setNotice(null)}>Close</button></div>}
        {screen === 'map' && (
          <div className="map-wrap">
            <MapView
              style={style} view={view} startView={m.view} focus={saved.focus} minZoom={m.minZoom} maxZoom={m.maxZoom}
              placing={placing !== null} onPlace={(at) => void place(at)}
              drawing={drawing} onDrawn={(c, r) => void drawn(c, r)} onDrawRadius={setDrawRadius} onPickRoad={pick}
              goTo={goTo} onWent={() => setGoTo(null)} onView={onView} onTileError={setOffline}
            />
            {listedArea && (
              <RoadsPanel
                area={listedArea} roads={roads[listedArea.id]?.roads ?? null} report={report} edit={editArea} go={go}
                selected={selected?.startsWith(listedArea.id + KEY_SEP) ? selected.slice(listedArea.id.length + 1) : null}
                select={(k) => setSelected(k ? listedArea.id + KEY_SEP + k : null)}
                close={() => { setListed(null); setSelected(null); }}
              />
            )}
          </div>
        )}
        {screen === 'customize' && <Customize cfg={cfg} view={view} showOnMap={(v) => { setScreen('map'); go(v); }} />}
        {screen === 'settings' && <Settings status={status} />}
        {screen === 'help' && <Help />}
      </div>
    </div>
  );
}
