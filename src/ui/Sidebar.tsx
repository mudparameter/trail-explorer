import { useEffect, useState } from 'react';
import type { AreaView, Bounds, ConfigState, GroupView, LayerState, Status, View } from '../core/api.ts';
import { ACTIVITIES, type Activity } from '../core/activities.ts';
import { APP_ZONES, bandLabels, layerState, MAX_WIDTH, MIN_WIDTH, type Config } from '../core/config.ts';
import { MAX_RADIUS, MIN_RADIUS, type Zone } from '../core/zones.ts';
import type { Placing, Screen } from './App.tsx';
import { trail } from './api.ts';
import { AreaList, type EditArea, type EditGroup, type EditMembers } from './Roads.tsx';

interface Props {
  status: Status;
  cfg: ConfigState;
  /** The config as shown, with layer changes that may not be saved yet. */
  config: Config;
  adding: boolean;
  screen: Screen;
  setScreen(s: Screen): void;
  change(l: LayerState[]): void;
  go(b: Bounds | View): void;
  goToRides(): void;
  addMap(): void;
  notice(message: string | null): void;
  showZones: boolean;
  setShowZones(on: boolean): void;
  placing: Placing;
  setPlacing(p: Placing): void;
  drawing: boolean;
  /** The group a circle being drawn goes in. */
  drawGroup: string | null;
  startDrawing(group?: string | null): void;
  /** Opens the route planner. */
  openPlanner(): void;
  areas: AreaView[];
  groups: GroupView[];
  listArea(id: string): void;
  editArea: EditArea;
  editGroup: EditGroup;
  editMembers: EditMembers;
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

const SCREENS: [Screen, string][] = [['map', 'Map'], ['routes', 'Routes'], ['customize', 'Customize'], ['settings', 'Settings'], ['help', 'Help']];

/** Where a zone is, for "Go to". */
function zoneBounds(z: Zone): Bounds {
  if (z.kind === 'circle') {
    const d = z.radius / 111_320;
    const k = d / Math.max(Math.cos((z.center[1] * Math.PI) / 180), 0.01);
    return [z.center[0] - k * 1.5, z.center[1] - d * 1.5, z.center[0] + k * 1.5, z.center[1] + d * 1.5];
  }
  const ps = z.polygons.flatMap((p) => p[0]!);
  return [Math.min(...ps.map((p) => p[0])), Math.min(...ps.map((p) => p[1])), Math.max(...ps.map((p) => p[0])), Math.max(...ps.map((p) => p[1]))];
}

export function Sidebar(p: Props) {
  const { status, cfg, config } = p;
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const s = status.sync;
  const states: LayerState[] = config.layers.map(layerState);
  const set = (id: string, v: Partial<LayerState>) => p.change(states.map((l) => (l.id === id ? { ...l, ...v } : l)));
  const move = (i: number, d: number) => {
    const ls = [...states];
    const [l] = ls.splice(i, 1);
    ls.splice(i + d, 0, l!);
    p.change(ls);
  };
  const busy = s.state !== 'idle' && s.state !== 'error' && s.state !== 'key-rejected';
  const labels = bandLabels(config.heatmap.bands);
  const report = async (r: Promise<{ ok: boolean; error?: string }>) => {
    const x = await r;
    if (!x.ok) p.notice(x.error ?? 'Something went wrong.');
    return x.ok;
  };

  return (
    <aside className="side">
      <h1>Trail Explorer</h1>
      <nav>
        {SCREENS.map(([x, label]) => (
          <button key={x} className="link" aria-current={p.screen === x ? 'page' : undefined} onClick={() => p.setScreen(x)}>{label}</button>
        ))}
      </nav>

      <h2>Rides</h2>
      {s.state === 'downloading' ? (
        <>
          <p>{s.done} of {s.total} rides</p>
          <progress value={s.done} max={s.total || 1} aria-label="Rides downloaded" />
        </>
      ) : (
        <ActivityFilter status={status} config={config} report={report} />
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
        {config.layers.map((l, i) => {
          const info = l.type === 'file' ? cfg.maps[l.id] : undefined;
          const missing = l.type === 'file' && !info;
          return (
            <li key={l.id}>
              <div className="row top">
                <label>
                  <input type="checkbox" checked={l.on} onChange={(e) => set(l.id, { on: e.target.checked })} /> {l.name}
                  {l.note && <span className="small"> {l.note}</span>}
                  {missing && <span className="small error"> (file not found)</span>}
                </label>
                <span className="order">
                  <button aria-label={`Move ${l.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button aria-label={`Move ${l.name} down`} disabled={i === config.layers.length - 1} onClick={() => move(i, 1)}>↓</button>
                </span>
              </div>
              {l.on && (
                <input type="range" min={0.1} max={1} step={0.05} value={l.opacity} aria-label={`${l.name} opacity`} title="Opacity"
                  onChange={(e) => set(l.id, { opacity: Number(e.target.value) })} />
              )}
              {l.on && (l.type === 'heatmap' || l.type === 'roads') && (
                <label className="small slider">
                  Line width
                  <input type="range" min={MIN_WIDTH} max={MAX_WIDTH} step={0.05} value={l.width ?? 1} aria-label={`${l.name} line width`} title="Line width"
                    onChange={(e) => set(l.id, { width: Number(e.target.value) })} onDoubleClick={() => set(l.id, { width: 1 })} />
                </label>
              )}
              {l.type === 'file' && edit?.id === l.id && (
                <form className="row" onSubmit={async (e) => {
                  e.preventDefault();
                  if (await report(trail.renameMap(l.id, edit.name))) setEdit(null);
                }}>
                  <input value={edit.name} maxLength={100} autoFocus aria-label="Map name" onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                  <button>Save</button>
                </form>
              )}
              {l.type === 'file' && confirm === l.id ? (
                <div className="row small">
                  Remove this map and delete its file?
                  <button onClick={() => {
                    setConfirm(null);
                    void report(trail.removeMap(l.id));
                  }}>Remove</button>
                  <button onClick={() => setConfirm(null)}>Keep</button>
                </div>
              ) : l.type === 'file' && (
                <div className="row small">
                  {info && <button className="link" onClick={() => { p.setScreen('map'); p.go(info.bounds); }}>Go to</button>}
                  <button className="link" onClick={() => setEdit(edit ? null : { id: l.id, name: l.name })}>Rename</button>
                  <button className="link" onClick={() => setConfirm(l.id)}>Remove</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <button disabled={p.adding} onClick={p.addMap}>{p.adding ? 'Adding map…' : 'Add map'}</button>
      <p className="small">Or drop a map file on the window.</p>

      <Zones {...p} report={report} />

      <AreaList
        areas={p.areas} groups={p.groups} edit={p.editArea} editGroup={p.editGroup} editMembers={p.editMembers}
        drawing={p.drawing} drawGroup={p.drawGroup} startDrawing={p.startDrawing} report={report} list={p.listArea}
        go={(b) => { p.setScreen('map'); p.go(b); }}
      />
      <div className="planner-cta">
        <button className="primary" disabled={!p.areas.some((a) => a.state === 'ready')} onClick={p.openPlanner}>Route planner →</button>
        <p className="small">{p.areas.some((a) => a.state === 'ready') ? 'Plan routes in these areas that take in trails you haven\'t ridden.' : 'Draw an area first, then plan routes in it.'}</p>
      </div>

      <h2>Times ridden</h2>
      <ul className="legend">
        {config.heatmap.bands.map((b, i) => (
          <li key={b.from}><span style={{ background: b.color, borderColor: config.heatmap.outline }} />{labels[i]}</li>
        ))}
      </ul>
    </aside>
  );
}

function Zones(p: Props & { report(r: Promise<{ ok: boolean; error?: string }>): Promise<boolean> }) {
  const zones = p.config.zones;
  const [edit, setEdit] = useState<{ id: string; name: string; radius: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <>
      <h2>Excluded zones</h2>
      <p className="small">Rides are left out inside these areas, such as around home.</p>
      <label className="small"><input type="checkbox" checked={p.showZones} onChange={(e) => p.setShowZones(e.target.checked)} /> Show zones on the map</label>
      <ul className="layers">
        {zones.map((z) => (
          <li key={z.id}>
            <div>
              {z.name}
              <span className="small"> {z.kind === 'circle' ? `${z.radius} m` : 'drawn area'}{z.file !== APP_ZONES && `, ${z.file.replace('zones/', '')}`}</span>
            </div>
            {edit?.id === z.id ? (
              <form className="zone-edit" onSubmit={async (e) => {
                e.preventDefault();
                if (await p.report(trail.editZone(z.id, { name: edit.name, radius: Number(edit.radius) }))) setEdit(null);
              }}>
                <label>Name <input value={edit.name} maxLength={100} autoFocus onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
                <label>Radius (m) <input type="number" min={MIN_RADIUS} max={MAX_RADIUS} step={10} value={edit.radius} onChange={(e) => setEdit({ ...edit, radius: e.target.value })} /></label>
                <div className="row"><button>Save</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></div>
              </form>
            ) : confirm === z.id ? (
              <div className="row small">
                Remove this zone?
                <button onClick={() => { setConfirm(null); void p.report(trail.removeZone(z.id)); }}>Remove</button>
                <button onClick={() => setConfirm(null)}>Keep</button>
              </div>
            ) : (
              <div className="row small">
                <button className="link" onClick={() => { p.setScreen('map'); p.go(zoneBounds(z)); }}>Go to</button>
                {z.editable && z.kind === 'circle' && (
                  <>
                    <button className="link" onClick={() => setEdit({ id: z.id, name: z.name, radius: String(z.radius) })}>Edit</button>
                    <button className="link" onClick={() => p.setPlacing({ kind: 'move', id: z.id })}>Move</button>
                  </>
                )}
                {z.file === APP_ZONES && <button className="link" onClick={() => setConfirm(z.id)}>Remove</button>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <button disabled={p.placing !== null} onClick={() => p.setPlacing({ kind: 'new' })}>Add zone</button>
      {zones.some((z) => z.file !== APP_ZONES) && <p className="small">Zones from other files are changed by editing those files.</p>}
    </>
  );
}


/** How many rides are on the map, and a checkbox for each kind of activity there is. */
function ActivityFilter({ status, config, report }: { status: Status; config: Config; report(r: Promise<{ ok: boolean; error?: string }>): Promise<boolean> }) {
  // Shown at once, before the file is saved and read back.
  const [pending, setPending] = useState<Activity[] | null>(null);
  const saved = config.heatmap.hide;
  useEffect(() => setPending(null), [saved]);
  const hide = pending ?? saved;
  const counts = status.activities;
  const kinds = ACTIVITIES.filter((a) => counts[a.id] || hide.includes(a.id));
  const shown = kinds.reduce((n, a) => n + (hide.includes(a.id) ? 0 : counts[a.id] ?? 0), 0);
  const hidden = status.sync.onMap - shown;
  const toggle = (a: Activity) => {
    const next = hide.includes(a) ? hide.filter((x) => x !== a) : [...hide, a];
    setPending(next);
    void report(trail.saveConfig('heatmap.json', { ...config.heatmap, hide: next })).then((ok) => ok || setPending(null));
  };
  return (
    <>
      <p>
        {shown} ride{shown === 1 ? '' : 's'} on the map
        {hidden > 0 && <span className="small"> ({hidden} hidden)</span>}
      </p>
      {kinds.length > 1 && (
        <ul className="activities" aria-label="Kinds of activity">
          {kinds.map((a) => (
            <li key={a.id}>
              <label>
                <input type="checkbox" checked={!hide.includes(a.id)} onChange={() => toggle(a.id)} /> {a.label}
                <span className="small"> {counts[a.id] ?? 0}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
