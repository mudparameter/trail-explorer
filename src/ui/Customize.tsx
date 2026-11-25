// The configurer: edits the files in the config folder, checking them the same
// way the app does when it reads them, so what is saved always loads.
import { useRef, useState, type ReactNode } from 'react';
import type { ConfigFile, ConfigState, Status, View } from '../core/api.ts';
import { bandLabels, checkFile, DEFAULTS, LINE_STYLES, MAX_LINE, MIN_LINE, newMapIndex, type Band, type AreaLine, type HeatmapConfig, type LayerDef, type LineStyle, type MapConfig } from '../core/config.ts';
import { trail } from './api.ts';

interface Props {
  cfg: ConfigState;
  status: Status;
  /** Where the map is now. */
  view: View | null;
  showOnMap(v: View): void;
}

export function Customize({ cfg, status, view, showOnMap }: Props) {
  const { config } = cfg;
  const { rides, storage } = status.features;
  return (
    <main className="page wide">
      <h1>Customize</h1>
      {storage === 'folder' ? (
        <p>
          Everything here is saved as plain files in the config folder, so you can also edit them by hand, keep them in a
          private git repository, or copy them to another computer. Changes to the files show here as soon as they are saved.
        </p>
      ) : (
        <p>
          Everything here, with your areas and saved routes, is kept in this browser as the same files the desktop app keeps in
          its config folder. Export them as a .zip to keep a copy, edit them, or use them in the desktop app.
        </p>
      )}
      <Folder cfg={cfg} status={status} />
      {/* Each section starts again from the file whenever the file changes. */}
      <MapSection key={JSON.stringify(config.map)} value={config.map} view={view} showOnMap={showOnMap} />
      {rides && <HeatmapSection key={JSON.stringify(config.heatmap)} value={config.heatmap} />}
      <LayersSection key={JSON.stringify(config.layers)} value={config.layers} cfg={cfg} />
      <OutlineSection key={`outline ${JSON.stringify(config.map)}`} value={config.map} />
      {rides && (
        <>
          <h2>Excluded zones</h2>
          <p>
            Add, move and resize zones in the sidebar on the map. They are kept in <code>zones/zones.geojson</code>. Any other
            <code> .geojson</code> file in the <code>zones</code> folder is used too, so you can draw shapes in a tool such as geojson.io.
          </p>
        </>
      )}
    </main>
  );
}

function Folder({ cfg, status }: { cfg: ConfigState; status: Status }) {
  const [error, setError] = useState<string | null>(null);
  const run = async (r: Promise<{ ok: boolean; error?: string }>) => {
    const x = await r;
    setError(x.ok ? null : (x.error ?? 'Something went wrong.'));
  };
  const b = status.backup;
  return (
    <>
      {status.features.storage === 'folder' ? (
        <>
          <h2>Config folder</h2>
          <p><code className="path">{cfg.dir}</code></p>
          <p className="small">
            {cfg.source === 'env' ? 'Chosen by the TRAIL_CONFIG variable.' : cfg.source === 'chosen' ? 'A folder you chose.' : 'The default folder.'}
            {' '}Keep it private: zones show where you live.
          </p>
          <div className="row">
            <button onClick={() => void trail.openConfigDir()}>Open folder</button>
            {cfg.source !== 'env' && <button onClick={() => void run(trail.pickConfigDir())}>Use another folder…</button>}
            {cfg.source === 'chosen' && <button onClick={() => void run(trail.useDefaultConfigDir())}>Use the default folder</button>}
          </div>
        </>
      ) : (
        <>
          <h2>Your config</h2>
          <p className="small">
            Kept in this browser on this computer only. Clearing site data, private windows, or a browser that tidies up storage
            (Safari does after a week away) can lose it, so export a copy now and then.
            {b && (b.unsaved > 0
              ? ` ${b.unsaved} change${b.unsaved === 1 ? '' : 's'} since ${b.lastExport ? `the last export, ${new Date(b.lastExport).toLocaleString()}` : 'you started'}.`
              : b.lastExport ? ` Everything is in the last export, ${new Date(b.lastExport).toLocaleString()}.` : '')}
          </p>
        </>
      )}
      <ExportImport />
      {error && <p className="error" role="alert">{error}</p>}
      {cfg.problems.length > 0 && (
        <div className="problems" role="alert">
          <p><strong>Problems found in the files.</strong> The app uses the default for each of these until it is fixed.</p>
          <ul>{cfg.problems.map((p, i) => <li key={i}><code>{p.file}</code> {p.message}</li>)}</ul>
        </div>
      )}
    </>
  );
}

/** A section that edits one file: a draft, checked as you type, with Save, Undo and Defaults. */
function Section<T>({ title, file, value, defaults, toFile, intro, children }: {
  title: string;
  file: ConfigFile;
  value: T;
  defaults: T;
  toFile(v: T): unknown;
  intro?: ReactNode;
  children(draft: T, set: (v: T) => void): ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);
  const problems = checkFile(file, toFile(draft));
  const save = async () => {
    setSaving(true);
    const r = await trail.saveConfig(file, toFile(draft));
    setSaving(false);
    setError(r.ok ? null : r.error);
  };
  return (
    <section className="section">
      <h2>{title} <span className="small">({file})</span></h2>
      {intro}
      {children(draft, (v) => { setDraft(v); setError(null); })}
      {problems.length > 0 && <ul className="error">{problems.map((p, i) => <li key={i}>{p.message}</li>)}</ul>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button disabled={!dirty || problems.length > 0 || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
        <button disabled={!dirty} onClick={() => setDraft(value)}>Undo changes</button>
        <button disabled={JSON.stringify(draft) === JSON.stringify(defaults)} onClick={() => setDraft(defaults)}>Use defaults</button>
        {dirty && <span className="small">Not saved yet</span>}
      </div>
    </section>
  );
}

/** A number box that keeps what is typed, even half-typed, and reports NaN when empty. */
function Num({ label, value, set, min, max, step = 1, hint }: { label: string; value: number; set(v: number): void; min: number; max: number; step?: number; hint?: string }) {
  return (
    <label>
      {label}
      <input type="number" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step} onChange={(e) => set(e.target.value === '' ? NaN : Number(e.target.value))} />
      {hint && <span className="small">{hint}</span>}
    </label>
  );
}
/** `bare` hides the label, for a table that already has a heading. */
function Colour({ label, value, set, bare }: { label: string; value: string; set(v: string): void; bare?: boolean }) {
  // A colour picker needs six digits.
  const six = /^#[0-9a-f]{3}$/i.test(value) ? `#${[...value.slice(1)].map((c) => c + c).join('')}` : /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  return (
    <label className="colour">
      {!bare && label}
      <span className="row">
        <input type="color" value={six} aria-label={`${label} picker`} onChange={(e) => set(e.target.value)} />
        <input value={value} maxLength={7} aria-label={label} onChange={(e) => set(e.target.value.trim())} />
      </span>
    </label>
  );
}

function MapSection({ value, view, showOnMap }: { value: MapConfig; view: View | null; showOnMap(v: View): void }) {
  const round = (v: View): View => ({ center: [Math.round(v.center[0] * 1e5) / 1e5, Math.round(v.center[1] * 1e5) / 1e5], zoom: Math.round(v.zoom * 100) / 100 });
  return (
    <Section title="Map" file="map.json" value={value} defaults={DEFAULTS.map} toFile={(v) => v}>
      {(d, set) => (
        <div className="form">
          <div>
            <strong>Start view</strong>
            <p className="small">Where the map opens the first time, and on a website. After that the app remembers where you left it.</p>
            {d.view ? (
              <div className="fields">
                <Num label="Longitude" value={d.view.center[0]} min={-180} max={180} step={0.0001} set={(x) => set({ ...d, view: { ...d.view!, center: [x, d.view!.center[1]] } })} />
                <Num label="Latitude" value={d.view.center[1]} min={-85} max={85} step={0.0001} set={(x) => set({ ...d, view: { ...d.view!, center: [d.view!.center[0], x] } })} />
                <Num label="Zoom" value={d.view.zoom} min={0} max={22} step={0.1} set={(x) => set({ ...d, view: { ...d.view!, zoom: x } })} />
              </div>
            ) : (
              <p>Fits the map to your rides.</p>
            )}
            <div className="row">
              <button disabled={!view} onClick={() => view && set({ ...d, view: round(view) })}>Use the current map view</button>
              {d.view && <button onClick={() => set({ ...d, view: null })}>Fit to my rides instead</button>}
              {d.view && <button onClick={() => showOnMap(d.view!)}>Show on the map</button>}
            </div>
          </div>
          <div className="fields">
            <Num label="Furthest out (zoom)" value={d.minZoom} min={0} max={22} step={0.5} set={(x) => set({ ...d, minZoom: x })} hint="0 shows the whole world" />
            <Num label="Furthest in (zoom)" value={d.maxZoom} min={0} max={22} step={0.5} set={(x) => set({ ...d, maxZoom: x })} hint="19 is street level" />
          </div>
          <Colour label="Background" value={d.background} set={(x) => set({ ...d, background: x })} />
          <label>
            Road and trail data servers
            <textarea
              rows={2} value={d.overpass.join('\n')} spellCheck={false}
              onChange={(e) => {
                const lines = e.target.value.split('\n');
                set({ ...d, overpass: lines.filter((l, i) => l.trim() || i === lines.length - 1).map((l) => l.trim()) });
              }}
            />
            <span className="small">Overpass API addresses, one per line, tried in order when one is busy. The area you search is sent to them.</span>
          </label>
        </div>
      )}
    </Section>
  );
}

const STYLE_NAMES: Record<LineStyle, string> = { solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted' };

/** How drawn areas look. Kept in map.json with the rest of the map's look. */
function OutlineSection({ value }: { value: MapConfig }) {
  return (
    <Section title="Roads and trails outline" file="map.json" value={value} defaults={{ ...value, outline: DEFAULTS.map.outline }} toFile={(v) => v}
      intro={
        <p className="small">
          How the edge of the circles and rectangles drawn under Roads and trails looks, on the map and in the route planner. The shapes
          themselves, and their groups, are kept in <code>areas.json</code>, one per line. The road data they download is kept by the app,
          shared between overlapping areas, and not in this folder.
        </p>
      }>
      {(d, set) => {
        const c = (x: Partial<AreaLine>) => set({ ...d, outline: { ...d.outline, ...x } });
        return (
          <div className="form">
            <div className="fields">
              <Colour label="Outline colour" value={d.outline.color} set={(x) => c({ color: x })} />
              <Num label="Thickness (px)" value={d.outline.width} min={MIN_LINE} max={MAX_LINE} step={0.5} set={(x) => c({ width: x })} />
              <label>
                Line
                <select value={d.outline.style} onChange={(e) => c({ style: e.target.value as LineStyle })}>
                  {LINE_STYLES.map((x) => <option key={x} value={x}>{STYLE_NAMES[x]}</option>)}
                </select>
              </label>
            </div>
            <div>
              <strong>Preview</strong>
              <OutlinePreview line={d.outline} />
            </div>
          </div>
        );
      }}
    </Section>
  );
}

/** A circle and a rectangle, drawn as the map would. */
function OutlinePreview({ line }: { line: AreaLine }) {
  const w = Number.isFinite(line.width) ? Math.min(Math.max(line.width, MIN_LINE), MAX_LINE) : 2;
  const colour = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(line.color) ? line.color : '#000000';
  const dash = line.style === 'dashed' ? `${w * 3} ${w * 2}` : line.style === 'dotted' ? `0 ${w * 2}` : undefined;
  return (
    <svg className="outline-preview" width="220" height="110" viewBox="0 0 220 110" role="img" aria-label="Preview of the outline">
      <rect width="220" height="110" fill="#eeeeee" />
      <circle cx="70" cy="55" r="40" fill={colour} fillOpacity={0.05} stroke={colour} strokeWidth={w} strokeDasharray={dash} strokeLinecap={line.style === 'dotted' ? 'round' : 'butt'} />
      <rect x="125" y="20" width="75" height="70" fill={colour} fillOpacity={0.05} stroke={colour} strokeWidth={w} strokeDasharray={dash} strokeLinecap={line.style === 'dotted' ? 'round' : 'butt'} strokeLinejoin="round" />
    </svg>
  );
}

function HeatmapSection({ value }: { value: HeatmapConfig }) {
  return (
    <Section title="Heatmap colours" file="heatmap.json" value={value} defaults={DEFAULTS.heatmap} toFile={(v) => v}
      intro={<p className="small">Each band colours sections ridden at least “from” times, up to the next band. The first band must start at 1.</p>}>
      {(d, set) => {
        const labels = bandLabels(d.bands.map((b) => ({ ...b, label: undefined })));
        const band = (i: number, b: Partial<Band>) => set({ ...d, bands: d.bands.map((x, j) => (j === i ? { ...x, ...b } : x)) });
        return (
          <div className="form">
            <table className="bands">
              <thead><tr><th>From</th><th>Colour</th><th>Legend text</th><th /></tr></thead>
              <tbody>
                {d.bands.map((b, i) => (
                  <tr key={i}>
                    <td><input type="number" min={1} value={Number.isFinite(b.from) ? b.from : ''} aria-label={`Band ${i + 1} from`} onChange={(e) => band(i, { from: e.target.value === '' ? NaN : Number(e.target.value) })} /></td>
                    <td><Colour bare label={`Band ${i + 1} colour`} value={b.color} set={(c) => band(i, { color: c })} /></td>
                    <td><input value={b.label ?? ''} placeholder={labels[i]} maxLength={40} aria-label={`Band ${i + 1} legend text`} onChange={(e) => band(i, { label: e.target.value || undefined })} /></td>
                    <td><button aria-label={`Remove band ${i + 1}`} disabled={d.bands.length === 1} onClick={() => set({ ...d, bands: d.bands.filter((_, j) => j !== i) })}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button disabled={d.bands.length >= 12} onClick={() => {
              const last = d.bands.at(-1)!;
              set({ ...d, bands: [...d.bands, { from: Number.isFinite(last.from) ? last.from * 2 : 2, color: '#000000' }] });
            }}>Add band</button>
            <Colour label="Outline" value={d.outline} set={(x) => set({ ...d, outline: x })} />
            <div>
              <strong>Preview</strong>
              <ul className="legend">
                {d.bands.map((b, i) => <li key={i}><span style={{ background: b.color, borderColor: d.outline }} />{b.label || labels[i]}</li>)}
              </ul>
            </div>
            <details>
              <summary>How rides are matched</summary>
              <p className="small">These change how rides are joined into one network. Changing them redraws the heatmap.</p>
              <div className="fields">
                <Num label="Join distance (m)" value={d.radius} min={3} max={100} set={(x) => set({ ...d, radius: x })} hint="Rides this close share a section" />
                <Num label="Direction difference (°)" value={d.angle} min={5} max={90} set={(x) => set({ ...d, angle: x })} hint="More than this is a different trail" />
                <Num label="Detail (m)" value={d.step} min={2} max={50} set={(x) => set({ ...d, step: x })} hint="Length of the pieces trails are made of" />
              </div>
            </details>
          </div>
        );
      }}
    </Section>
  );
}

function LayersSection({ value, cfg }: { value: LayerDef[]; cfg: ConfigState }) {
  return (
    <Section title="Layers" file="layers.json" value={value} defaults={DEFAULTS.layers} toFile={(v) => ({ layers: v })}
      intro={<p className="small">Turn layers on and off, reorder them and set opacity in the sidebar. Here you can rename them and add web maps. Map files are added with Add map in the sidebar.</p>}>
      {(d, set) => {
        const layer = (i: number, l: Partial<LayerDef>) => set(d.map((x, j) => (j === i ? ({ ...x, ...l } as LayerDef) : x)));
        const freeId = () => {
          let id = 'web-map';
          for (let n = 2; d.some((l) => l.id === id); n++) id = `web-map-${n}`;
          return id;
        };
        return (
          <div className="form">
            {d.map((l, i) => (
              <fieldset key={l.id} className="layer">
                <legend>{l.name || l.id} <span className="small">{l.type === 'raster' ? 'web map' : l.type === 'file' ? `file ${l.file}` : l.type === 'heatmap' ? 'your rides' : l.type === 'roads' ? 'lines in drawn areas' : 'OpenFreeMap'}</span></legend>
                <div className="fields">
                  <label>Name<input value={l.name} maxLength={100} onChange={(e) => layer(i, { name: e.target.value })} /></label>
                  <label>Note<input value={l.note ?? ''} maxLength={100} placeholder="Shown after the name" onChange={(e) => layer(i, { note: e.target.value || undefined })} /></label>
                </div>
                {l.type === 'raster' && (
                  <>
                    <label>
                      Tile addresses, one per line
                      <textarea rows={Math.max(2, l.tiles.length)} value={l.tiles.join('\n')} spellCheck={false}
                        placeholder="https://tiles.example.org/{z}/{x}/{y}.png"
                        onChange={(e) => layer(i, { tiles: e.target.value.split('\n').map((t) => t.trim()).filter(Boolean) })} />
                      <span className="small">Each needs {'{z}'}, {'{x}'} and {'{y}'}. List each server on its own line instead of using {'{s}'}.</span>
                    </label>
                    <label>Credit shown on the map<input value={l.attribution} maxLength={1000} onChange={(e) => layer(i, { attribution: e.target.value })} /></label>
                    <div className="fields">
                      <Num label="Lowest zoom" value={l.minzoom} min={0} max={22} set={(x) => layer(i, { minzoom: x })} />
                      <Num label="Highest zoom" value={l.maxzoom} min={0} max={22} set={(x) => layer(i, { maxzoom: x })} />
                    </div>
                  </>
                )}
                {l.type === 'file' && !cfg.maps[l.id] && <p className="small error">The file is not in the maps folder.</p>}
                {l.type !== 'heatmap' && l.type !== 'roads' && <button onClick={() => set(d.filter((_, j) => j !== i))}>Remove layer</button>}
                {l.type === 'file' && <span className="small"> The file stays in the maps folder.</span>}
              </fieldset>
            ))}
            <button onClick={() => {
              const at = newMapIndex(d);
              const l: LayerDef = { id: freeId(), type: 'raster', name: 'Web map', on: true, opacity: 1, tiles: [], tileSize: 256, minzoom: 0, maxzoom: 19, attribution: '' };
              set([...d.slice(0, at), l, ...d.slice(at)]);
            }}>Add web map</button>
          </div>
        );
      }}
    </Section>
  );
}

/** Saves the whole config as one .zip, or replaces it from one. The same .zip works in the desktop app and on the website. */
function ExportImport() {
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [confirm, setConfirm] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = async (f: File) => {
    setConfirm(null);
    const r = await trail.importConfig(new Uint8Array(await f.arrayBuffer()));
    if (!r.ok) return setMsg({ text: r.error, error: true });
    const v = r.value;
    setMsg({
      text: `Imported ${v.files} file${v.files === 1 ? '' : 's'} from ${f.name}.${v.skipped.length ? ` Left out ${v.skipped.length} that ${v.skipped.length === 1 ? 'is' : 'are'} not part of a config.` : ''}${v.problems ? ` ${v.problems} problem${v.problems === 1 ? '' : 's'} found: see below.` : ''}`,
      error: false,
    });
  };
  return (
    <>
      <div className="row">
        <button onClick={async () => {
          const r = await trail.exportConfig();
          setMsg(r.ok ? (r.value ? { text: 'Exported.', error: false } : null) : { text: r.error, error: true });
        }}>Export config (.zip)</button>
        <button onClick={() => input.current?.click()}>Import config…</button>
        <input ref={input} type="file" accept=".zip,application/zip" hidden aria-label="Config .zip to import"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setConfirm(f); }} />
      </div>
      {confirm && (
        <div className="row small" role="alert">
          Replace your config with the files in {confirm.name}? Settings, areas and saved routes it holds replace yours. Map files are kept.
          <button onClick={() => void load(confirm)}>Replace</button>
          <button onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      )}
      {msg && <p className={`small${msg.error ? ' error' : ''}`} role="status">{msg.text}</p>}
    </>
  );
}
