import { useState } from 'react';
import type { Bounds, LayerState, MapInfo, Status } from '../core/api.ts';
import { trail } from './api.ts';
import { COLORS, DEFAULT_MAPS, HEATMAP, LEGEND } from './mapstyle.ts';

interface Props {
  status: Status;
  layers: LayerState[];
  maps: MapInfo[];
  adding: boolean;
  screen: string;
  setScreen(s: 'map' | 'settings' | 'help'): void;
  change(l: LayerState[]): void;
  go(b: Bounds): void;
  goToRides(): void;
  addMap(): void;
  renamed(id: string, name: string): void;
  removed(id: string): void;
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function Sidebar(p: Props) {
  const { status, layers, maps } = p;
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const s = status.sync;
  const set = (id: string, v: Partial<LayerState>) => p.change(layers.map((l) => (l.id === id ? { ...l, ...v } : l)));
  const move = (i: number, d: number) => {
    const ls = [...layers];
    const [l] = ls.splice(i, 1);
    ls.splice(i + d, 0, l!);
    p.change(ls);
  };
  const busy = s.state !== 'idle' && s.state !== 'error' && s.state !== 'key-rejected';

  return (
    <aside className="side">
      <h1>Trail Explorer</h1>
      <nav>
        {(['map', 'settings', 'help'] as const).map((x) => (
          <button key={x} className="link" aria-current={p.screen === x ? 'page' : undefined} onClick={() => p.setScreen(x)}>
            {x[0]!.toUpperCase() + x.slice(1)}
          </button>
        ))}
      </nav>

      <h2>Rides</h2>
      {s.state === 'downloading' ? (
        <>
          <p>{s.done} of {s.total} rides</p>
          <progress value={s.done} max={s.total || 1} aria-label="Rides downloaded" />
        </>
      ) : (
        <p>{s.onMap} ride{s.onMap === 1 ? '' : 's'} on the map</p>
      )}
      {s.message && <p className="small">{s.message}</p>}
      {s.buildingHeatmap && <p className="small">Drawing the heatmap…</p>}
      {s.noGps > 0 && <p className="small">{s.noGps} without GPS skipped</p>}
      {s.failed > 0 && <p className="small">{s.failed} could not be read</p>}
      <p className="small">Last sync: {ago(s.lastSync)}</p>
      <div className="row">
        <button disabled={busy || !status.hasKey} onClick={() => void trail.syncNow()}>Sync now</button>
        <button onClick={p.goToRides}>Go to my rides</button>
      </div>

      <h2>Layers</h2>
      <p className="small">The top of the list is drawn on top.</p>
      <ul className="layers">
        {layers.map((l, i) => {
          const def = DEFAULT_MAPS.find((d) => d.id === l.id);
          const map = maps.find((m) => m.id === l.id);
          const name = l.id === HEATMAP ? 'My rides' : (def?.name ?? map?.name ?? '');
          return (
            <li key={l.id}>
              <div className="row top">
                <label>
                  <input type="checkbox" checked={l.on} onChange={(e) => set(l.id, { on: e.target.checked })} /> {name}
                  {def && <span className="small"> {def.note}</span>}
                </label>
                <span className="order">
                  <button aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button aria-label={`Move ${name} down`} disabled={i === layers.length - 1} onClick={() => move(i, 1)}>↓</button>
                </span>
              </div>
              {l.on && (
                <input type="range" min={0.1} max={1} step={0.05} value={l.opacity} aria-label={`${name} opacity`} title="Opacity"
                  onChange={(e) => set(l.id, { opacity: Number(e.target.value) })} />
              )}
              {map && edit?.id === map.id && (
                <form className="row" onSubmit={async (e) => {
                  e.preventDefault();
                  const r = await trail.renameMap(map.id, edit.name);
                  if (r.ok) {
                    p.renamed(map.id, edit.name.trim());
                    setEdit(null);
                  }
                }}>
                  <input value={edit.name} maxLength={100} autoFocus aria-label="Map name" onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                  <button>Save</button>
                </form>
              )}
              {map && confirm === map.id ? (
                <div className="row small">
                  Remove this map?
                  <button onClick={async () => {
                    setConfirm(null);
                    if ((await trail.removeMap(map.id)).ok) p.removed(map.id);
                  }}>Remove</button>
                  <button onClick={() => setConfirm(null)}>Keep</button>
                </div>
              ) : map && (
                <div className="row small">
                  <button className="link" onClick={() => { p.setScreen('map'); p.go(map.bounds); }}>Go to</button>
                  <button className="link" onClick={() => setEdit(edit ? null : { id: map.id, name: map.name })}>Rename</button>
                  <button className="link" onClick={() => setConfirm(map.id)}>Remove</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <button disabled={p.adding} onClick={p.addMap}>{p.adding ? 'Adding map…' : 'Add map'}</button>
      <p className="small">Or drop a map file on the window.</p>

      <h2>Times ridden</h2>
      <ul className="legend">
        {LEGEND.map((t, i) => (
          <li key={t}><span style={{ background: COLORS[i] }} />{t}</li>
        ))}
      </ul>
    </aside>
  );
}
