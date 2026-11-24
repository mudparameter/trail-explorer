import { useEffect, useRef, useState } from 'react';
import type { AreaView, Bounds } from '../core/api.ts';
import type { AreaEdit } from '../core/areas.ts';
import { distance, KINDS, OSM_ATTRIBUTION, type Road, type RoadKind } from '../core/roads.ts';
import { circleRing } from '../core/zones.ts';
import { trail } from './api.ts';

const SHORT: Record<RoadKind, string> = { trail: 'trails', track: 'tracks', cycleway: 'cycleways', road: 'roads' };
export const areaName = (a: AreaView) => a.name ?? 'Unnamed area';

/** How the area's download is going, or what it holds. */
function summary(a: AreaView): string {
  if (a.state === 'ready') {
    const parts = KINDS.filter((k) => a.totals[k.kind]).map((k) => `${distance(a.totals[k.kind]!)} ${SHORT[k.kind]}`);
    return parts.length ? parts.join(' · ') : 'No roads or trails here';
  }
  const pct = a.total ? Math.floor((a.done / a.total) * 100) : 0;
  if (a.state === 'downloading') return `Downloading… ${pct}%`;
  if (a.state === 'queued') return pct ? `Waiting to download the rest (${pct}% done)` : 'Waiting to download…';
  return a.error ?? 'The download failed.';
}

export function areaBounds(a: AreaView): Bounds {
  const ring = circleRing(a.center, a.radius, 16);
  return [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))];
}

type Report = (r: Promise<{ ok: boolean; error?: string }>) => Promise<boolean>;
/** Changes or removes an area on screen at once, then saves it. */
export type EditArea = (id: string, edit: AreaEdit | 'remove') => void;

/** The sidebar's list of areas. */
export function AreaList({ areas, drawing, startDrawing, go, list, report, edit }: {
  areas: AreaView[];
  edit: EditArea;
  drawing: boolean;
  startDrawing(): void;
  go(b: Bounds): void;
  /** Opens the list of roads and trails for an area. */
  list(id: string): void;
  report: Report;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <>
      <h2>Roads and trails</h2>
      <p className="small">Draw circles on the map to find every road and trail in them, from OpenStreetMap. They are kept, and overlapping circles share their data.</p>
      <ul className="layers areas">
        {areas.map((a) => (
          <li key={a.id} data-area={a.id}>
            <div className="row top">
              <label>
                <input type="checkbox" checked={a.on} onChange={(e) => edit(a.id, { on: e.target.checked })} /> {areaName(a)}
                <span className="small"> {distance(a.radius)}</span>
              </label>
              <span className="order">
                <button aria-label={`Details of ${areaName(a)}`} aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? '▾' : '▸'}</button>
                <button aria-label={`Delete ${areaName(a)}`} title="Delete" onClick={() => setConfirm(a.id)}>×</button>
              </span>
            </div>
            <p className={`small${a.state === 'error' ? ' error' : ''}`}>{summary(a)}</p>
            {a.state === 'error' && <button className="link small" onClick={() => void report(trail.retryArea(a.id))}>Try again</button>}
            {confirm === a.id && (
              <div className="row small" role="alert">
                Delete this area? Data another area uses is kept.
                <button onClick={() => { setConfirm(null); if (open === a.id) setOpen(null); edit(a.id, 'remove'); }}>Delete</button>
                <button onClick={() => setConfirm(null)}>Keep</button>
              </div>
            )}
            {open === a.id && <AreaDetails area={a} go={go} list={list} edit={edit} />}
          </li>
        ))}
      </ul>
      <button disabled={drawing} onClick={startDrawing}>{drawing ? 'Drawing…' : 'Draw a circle'}</button>
    </>
  );
}

function AreaDetails({ area: a, go, list, edit }: { area: AreaView; go(b: Bounds): void; list(id: string): void; edit: EditArea }) {
  const [name, setName] = useState(a.name ?? '');
  useEffect(() => setName(a.name ?? ''), [a.name]);
  const saveName = () => {
    if (name.trim() !== (a.name ?? '')) edit(a.id, { name: name.trim() || null });
  };
  return (
    <div className="area-details">
      <label className="small">
        Name
        <input value={name} maxLength={100} placeholder="Optional" onChange={(e) => setName(e.target.value)} onBlur={saveName}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
      </label>
      <KindToggles area={a} edit={edit} />
      <div className="row small">
        <button className="link" onClick={() => go(areaBounds(a))}>Go to</button>
        <button className="link" onClick={() => list(a.id)}>List roads and trails</button>
      </div>
    </div>
  );
}

/** A checkbox for each kind of road, showing or hiding it in this area. */
function KindToggles({ area: a, edit }: { area: AreaView; edit: EditArea }) {
  return (
    <div className="kinds">
      {KINDS.map(({ kind, label, color }) => {
        const off = a.hide.includes(kind);
        const len = a.totals[kind];
        if (a.state === 'ready' && !len) return null;
        return (
          <label key={kind} className="kind-head">
            <input type="checkbox" checked={!off} onChange={() => edit(a.id, { hide: off ? a.hide.filter((h) => h !== kind) : [...a.hide, kind] })} />
            <span className="swatch" style={{ background: color }} />
            {label}
            {len !== undefined && <span className="small"> {distance(len)}</span>}
          </label>
        );
      })}
    </div>
  );
}

/** The roads and trails in one area, over the map. */
export function RoadsPanel({ area, roads, selected, select, go, report, edit, close }: {
  area: AreaView;
  edit: EditArea;
  roads: Road[] | null;
  /** The selected road's key in this area. */
  selected: string | null;
  select(key: string | null): void;
  go(b: Bounds): void;
  report: Report;
  close(): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // A road picked on the map scrolls into view here.
  useEffect(() => {
    if (!selected) return;
    list.current?.querySelector(`[data-key="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <section className="roads" aria-label="Roads and trails">
      <header>
        <strong>{areaName(area)}</strong>
        <span className="small">{distance(area.radius)} around</span>
        <button className="close" aria-label="Close the list" title="Close" onClick={close}>×</button>
      </header>
      {area.state !== 'ready' && (
        <p className={`small${area.state === 'error' ? ' error' : ''}`} role="status">
          {summary(area)} {area.state === 'error' && <button onClick={() => void report(trail.retryArea(area.id))}>Try again</button>}
        </p>
      )}
      {area.state === 'ready' && roads && (
        <>
          <p className="small">{roads.length ? 'Click a name to show it, or a line on the map.' : 'Nothing found in this circle.'}</p>
          <div className="roads-list" ref={list}>
            {KINDS.map(({ kind, label, color }) => {
              const rs = roads.filter((r) => r.kind === kind);
              if (!rs.length) return null;
              const off = area.hide.includes(kind);
              return (
                <div key={kind} className="kind">
                  <label className="kind-head">
                    <input type="checkbox" checked={!off} onChange={() => edit(area.id, { hide: off ? area.hide.filter((h) => h !== kind) : [...area.hide, kind] })} />
                    <span className="swatch" style={{ background: color }} />
                    {label}
                    <span className="small"> {distance(rs.reduce((n, r) => n + r.length, 0))}</span>
                  </label>
                  {!off && (
                    <ul>
                      {rs.map((r) => (
                        <li key={r.key} data-key={r.key}>
                          <button
                            className="road" aria-pressed={selected === r.key}
                            onClick={() => {
                              if (selected === r.key) select(null);
                              else {
                                select(r.key);
                                go(r.bounds);
                              }
                            }}
                          >
                            <span className="name">{r.name ?? <em>Unnamed</em>}</span>
                            <span className="small">{distance(r.length)}</span>
                            {(r.surface || r.difficulty || r.private || r.noBikes) && (
                              <span className="small detail">{[r.surface, r.difficulty, r.private && 'private in parts', r.noBikes && 'no bikes in parts'].filter(Boolean).join(' · ')}</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      <p className="small credit">Data {OSM_ATTRIBUTION}</p>
    </section>
  );
}
