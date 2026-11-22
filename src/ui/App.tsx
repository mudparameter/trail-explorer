import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Bounds, LayerState, MapInfo, Saved, Status, View } from '../core/api.ts';
import { trail } from './api.ts';
import { buildStyle, DEFAULT_MAPS, HEATMAP, type Bundled } from './mapstyle.ts';
import { MapView } from './MapView.tsx';
import { Help, KeyForm, Settings } from './Screens.tsx';
import { Sidebar } from './Sidebar.tsx';

type Screen = 'map' | 'settings' | 'help';

/** Saved layers, plus any map that is new, minus any that is gone. */
function mergeLayers(saved: LayerState[] | null, maps: MapInfo[]): LayerState[] {
  // The world map starts at the bottom, so a topo map shows when turned on.
  const ids = [HEATMAP, ...maps.map((m) => m.id), ...DEFAULT_MAPS.map((m) => m.id).reverse()];
  const out = (saved ?? []).filter((l) => ids.includes(l.id));
  for (const id of ids) {
    if (out.some((l) => l.id === id)) continue;
    const l = { id, on: id === HEATMAP || id === 'openfreemap' || maps.some((m) => m.id === id), opacity: 1 };
    if (maps.some((m) => m.id === id)) out.splice(out.findIndex((x) => x.id === HEATMAP) + 1, 0, l);
    else out.push(l);
  }
  return out;
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [maps, setMaps] = useState<MapInfo[]>([]);
  const [layers, setLayers] = useState<LayerState[]>([]);
  const [bundled, setBundled] = useState<Bundled | null>(null);
  const [screen, setScreen] = useState<Screen>('map');
  const [goTo, setGoTo] = useState<{ bounds: Bounds; n: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    const json = (u: string) => fetch(u).then((r) => r.json());
    void Promise.all([trail.getStatus(), trail.getSaved(), trail.listMaps(), json('trail://styles/liberty.json'), json('trail://styles/shortbread.json')])
      .then(([st, sv, ms, liberty, shortbread]) => {
        setMaps(ms);
        setLayers(mergeLayers(sv.layers, ms));
        setBundled({ liberty, shortbread });
        setSaved(sv);
        setView(sv.view);
        setStatus(st);
      });
    return trail.onStatus(setStatus);
  }, []);

  const change = useCallback((ls: LayerState[]) => {
    setLayers(ls);
    void trail.saveLayers(ls);
  }, []);
  const go = useCallback((bounds: Bounds) => setGoTo((g) => ({ bounds, n: (g?.n ?? 0) + 1 })), []);
  const onView = useCallback((v: View) => {
    setView(v);
    void trail.saveView(v);
  }, []);

  const added = (m: MapInfo) => {
    const ms = [...maps, m];
    setMaps(ms);
    change(mergeLayers(layers, ms));
    setScreen('map');
    go(m.bounds);
    setNotice(null);
  };
  const addMap = async (file?: File) => {
    if (adding) return;
    setAdding(true);
    setNotice(null);
    try {
      const r = file ? await trail.addDroppedMap(file) : await trail.pickMap();
      if (!r.ok) setNotice(r.error);
      else if (r.value) added(r.value);
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
  const style = useMemo(() => (bundled ? buildStyle(layers, maps, bundled, hv) : null), [layers, maps, bundled, hv]);
  if (!status || !saved || !style) return null;

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
        status={status} layers={layers} maps={maps} adding={adding} screen={screen} setScreen={setScreen} change={change} go={go}
        goToRides={goToRides} addMap={() => void addMap()}
        renamed={(id, name) => setMaps(maps.map((m) => (m.id === id ? { ...m, name } : m)))}
        removed={(id) => {
          setMaps(maps.filter((m) => m.id !== id));
          change(layers.filter((l) => l.id !== id));
        }}
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
        {offline && <div className="notice">{offline}</div>}
        {notice && <div className="notice" role="alert">{notice} <button onClick={() => setNotice(null)}>Close</button></div>}
        {screen === 'map' && <MapView style={style} view={view} focus={saved.focus} goTo={goTo} onWent={() => setGoTo(null)} onView={onView} onTileError={setOffline} />}
        {screen === 'settings' && <Settings status={status} />}
        {screen === 'help' && <Help />}
      </div>
    </div>
  );
}
