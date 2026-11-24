import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bounds, ConfigState, LayerState, MapInfo, Saved, Status, View } from '../core/api.ts';
import type { Config } from '../core/config.ts';
import { distance, MIN_AREA, type RoadKind } from '../core/roads.ts';
import { trail } from './api.ts';
import { Customize } from './Customize.tsx';
import { buildStyle, type Bundled } from './mapstyle.ts';
import { MapView } from './MapView.tsx';
import { Help, KeyForm, Settings } from './Screens.tsx';
import { RoadsPanel, type Search } from './Roads.tsx';
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
    .map(({ l, at }) => (at ? { ...l, on: at.s.on, opacity: at.s.opacity } : l));
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
  const [search, setSearch] = useState<Search | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<RoadKind[]>([]);
  const searchId = useRef(0);

  const config = (c: ConfigState) => {
    setCfg(c);
    setLayers(c.config.layers.map((l) => ({ id: l.id, on: l.on, opacity: l.opacity })));
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
    const offStatus = trail.onStatus(setStatus);
    const offConfig = trail.onConfig(config);
    return () => {
      offStatus();
      offConfig();
    };
  }, []);
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
  const findRoads = async (center: [number, number], radius: number) => {
    const id = ++searchId.current;
    setSelected(null);
    setSearch({ center, radius, state: 'loading', roads: [] });
    const r = await trail.findRoads(center, radius);
    // A newer search, or Clear, wins.
    if (id !== searchId.current) return;
    setSearch(r.ok ? { center, radius, state: 'done', roads: r.value } : { center, radius, state: 'error', roads: [], error: r.error });
  };
  const drawn = (center: [number, number], radius: number) => {
    if (radius < MIN_AREA) {
      setDrawRadius(null);
      setNotice(`Make the circle at least ${MIN_AREA} m across from its centre. Click the centre again.`);
      return;
    }
    setNotice(null);
    setDrawing(false);
    void findRoads(center, radius);
  };
  const clearSearch = () => {
    searchId.current++;
    setSearch(null);
    setSelected(null);
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
  const explore = useMemo(
    () => (search ? { center: search.center, radius: search.radius, roads: search.roads.filter((r) => !hiddenKinds.includes(r.kind)), selected } : null),
    [search, hiddenKinds, selected],
  );
  const style = useMemo(
    () => (bundled && cfg && shown ? buildStyle({ config: shown, maps: cfg.maps, bundled, heatVersion: hv, showZones, drawing, explore }) : null),
    [shown, cfg, bundled, hv, showZones, drawing, explore],
  );
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
        drawing={drawing} startDrawing={startDrawing}
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
              drawing={drawing} onDrawn={drawn} onDrawRadius={setDrawRadius} onPickRoad={setSelected}
              goTo={goTo} onWent={() => setGoTo(null)} onView={onView} onTileError={setOffline}
            />
            {search && (
              <RoadsPanel
                search={search} selected={selected} select={setSelected} hidden={hiddenKinds} setHidden={setHiddenKinds}
                go={go} retry={() => void findRoads(search.center, search.radius)} redraw={startDrawing} close={clearSearch}
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
