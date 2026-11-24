import { useEffect, useRef, useState } from 'react';
import type { AreaView, Bounds, GroupView } from '../core/api.ts';
import type { AreaEdit, GroupEdit } from '../core/areas.ts';
import { distance, KINDS, OSM_ATTRIBUTION, type Road, type RoadKind } from '../core/roads.ts';
import { circleRing } from '../core/zones.ts';
import { trail } from './api.ts';

const SHORT: Record<RoadKind, string> = { trail: 'trails', track: 'tracks', cycleway: 'cycleways', road: 'roads' };
export const areaName = (a: AreaView | GroupView) => a.name ?? 'Unnamed area';
const circles = (n: number) => `${n} circle${n === 1 ? '' : 's'}`;

/** How the area's download is going, or what it holds. A separate group just says how its circles are doing. */
function summary(a: AreaView | GroupView): string {
  if ('members' in a && !a.joined) {
    if (a.state === 'ready') return `${circles(a.members.length)}, all downloaded`;
    if (a.state === 'error') return a.error ?? 'A download failed.';
  }
  if (a.state === 'ready') {
    const parts = KINDS.filter((k) => a.totals[k.kind]).map((k) => `${distance(a.totals[k.kind]!)} ${SHORT[k.kind]}`);
    return parts.length ? parts.join(' · ') : 'No roads or trails here';
  }
  const pct = a.total ? Math.floor((a.done / a.total) * 100) : 0;
  if (a.state === 'downloading') return `Downloading… ${pct}%`;
  if (a.state === 'queued') return pct ? `Waiting to download the rest (${pct}% done)` : 'Waiting to download…';
  return a.error ?? 'The download failed.';
}

/** Around one or more circles. */
export function areaBounds(...as: AreaView[]): Bounds {
  const ring = as.flatMap((a) => circleRing(a.center, a.radius, 16));
  return [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))];
}

type Report = (r: Promise<{ ok: boolean; error?: string }>) => Promise<boolean>;
/** Changes or removes an area on screen at once, then saves it. */
export type EditArea = (id: string, edit: AreaEdit | 'remove') => void;
/** Changes a group, or removes it: 'remove' keeps its circles, 'remove-all' deletes them too. */
export type EditGroup = (id: string, edit: GroupEdit | 'remove' | 'remove-all') => void;
export type EditMembers = (g: GroupView, edit: { on?: boolean; hide?: RoadKind[] }) => void;

interface ListProps {
  areas: AreaView[];
  groups: GroupView[];
  edit: EditArea;
  editGroup: EditGroup;
  editMembers: EditMembers;
  drawing: boolean;
  /** The group a circle being drawn goes in. */
  drawGroup: string | null;
  startDrawing(group?: string | null): void;
  go(b: Bounds): void;
  /** Opens the list of roads and trails for an area or a joined group. */
  list(id: string): void;
  report: Report;
}

/** The sidebar's list of areas, with groups where their first circle is. */
export function AreaList(p: ListProps) {
  const { areas, groups, drawing } = p;
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const shared = { open, setOpen, confirm, setConfirm };
  const items = areas.flatMap((a) => {
    const g = a.group ? groups.find((x) => x.id === a.group) : undefined;
    if (!g) return [<AreaItem key={a.id} area={a} {...p} {...shared} />];
    if (g.members[0] !== a.id) return [];
    return [<GroupItem key={g.id} group={g} {...p} {...shared} />];
  });
  return (
    <>
      <h2>Roads and trails</h2>
      <p className="small">Draw circles on the map to find every road and trail in them, from OpenStreetMap. They are kept, and overlapping circles share their data. Put circles that cover one place in a group with ▸.</p>
      <ul className="layers areas">{items}</ul>
      <button disabled={drawing} onClick={() => p.startDrawing(null)}>{drawing && !p.drawGroup ? 'Drawing…' : 'Draw a circle'}</button>
    </>
  );
}

type Shared = { open: string | null; setOpen(id: string | null): void; confirm: string | null; setConfirm(id: string | null): void };

function AreaItem({ area: a, edit, report, open, setOpen, confirm, setConfirm, ...p }: ListProps & Shared & { area: AreaView }) {
  return (
    <li data-area={a.id}>
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
      {open === a.id && <AreaDetails area={a} edit={edit} report={report} {...p} />}
    </li>
  );
}

function GroupItem({ group: g, areas, editGroup, editMembers, report, open, setOpen, confirm, setConfirm, ...p }: ListProps & Shared & { group: GroupView }) {
  const members = areas.filter((a) => a.group === g.id);
  const some = !g.on && members.some((m) => m.on);
  const [name, setName] = useState(g.name);
  useEffect(() => setName(g.name), [g.name]);
  const saveName = () => {
    if (name.trim() && name.trim() !== g.name) editGroup(g.id, { name: name.trim() });
    else setName(g.name);
  };
  return (
    <li data-group={g.id} className="group">
      <div className="row top">
        <label>
          <input type="checkbox" checked={g.on} ref={(el) => { if (el) el.indeterminate = some; }} onChange={(e) => editMembers(g, { on: e.target.checked })} /> {g.name}
          <span className="small"> {g.joined ? 'joined, ' : ''}{circles(members.length)}</span>
        </label>
        <span className="order">
          <button aria-label={`Details of ${g.name}`} aria-expanded={open === g.id} onClick={() => setOpen(open === g.id ? null : g.id)}>{open === g.id ? '▾' : '▸'}</button>
          <button aria-label={`Delete ${g.name}`} title="Delete" onClick={() => setConfirm(g.id)}>×</button>
        </span>
      </div>
      <p className={`small${g.state === 'error' ? ' error' : ''}`}>{summary(g)}</p>
      {g.state === 'error' && <button className="link small" onClick={() => void report(trail.retryArea(g.id))}>Try again</button>}
      {confirm === g.id && (
        <div className="row small" role="alert">
          Delete this group?
          <button onClick={() => { setConfirm(null); editGroup(g.id, 'remove'); }}>Keep its circles</button>
          <button onClick={() => { setConfirm(null); if (open === g.id) setOpen(null); editGroup(g.id, 'remove-all'); }}>Delete its circles too</button>
          <button onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      )}
      {open === g.id && (
        <div className="area-details">
          <label className="small">
            Group name
            <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} onBlur={saveName}
              onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
          </label>
          <label className="small check">
            <input type="checkbox" checked={g.joined} onChange={(e) => editGroup(g.id, { joined: e.target.checked })} /> Join into one area
          </label>
          <p className="small">{g.joined ? 'Shown as one area, with one outline and one list of roads and trails. Overlaps count once.' : 'Each circle is still its own area, listed below.'}</p>
          {g.joined && <KindToggles area={g} setHide={(hide) => editMembers(g, { hide })} />}
          <div className="row small">
            <button className="link" onClick={() => p.go(areaBounds(...members))}>Go to</button>
            {g.joined && <button className="link" onClick={() => p.list(g.id)}>List roads and trails</button>}
            <button className="link" disabled={p.drawing} onClick={() => p.startDrawing(g.id)}>{p.drawing && p.drawGroup === g.id ? 'Drawing…' : 'Draw a circle in this group'}</button>
            <button className="link" onClick={() => editGroup(g.id, 'remove')}>Ungroup</button>
          </div>
          {g.joined && (
            <ul className="members">
              {members.map((m) => (
                <li key={m.id} className="row small">
                  <span>{areaName(m)} · {distance(m.radius)}</span>
                  <button className="link" onClick={() => p.edit(m.id, { group: null })}>Take out</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!g.joined && (
        <ul className="layers group-areas">
          {members.map((a) => <AreaItem key={a.id} area={a} areas={areas} editGroup={editGroup} editMembers={editMembers} report={report} {...p} {...{ open, setOpen, confirm, setConfirm }} />)}
        </ul>
      )}
    </li>
  );
}

function AreaDetails({ area: a, go, list, edit, groups, report }: ListProps & { area: AreaView }) {
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
      <KindToggles area={a} setHide={(hide) => edit(a.id, { hide })} />
      <div className="row small">
        <button className="link" onClick={() => go(areaBounds(a))}>Go to</button>
        <button className="link" onClick={() => list(a.id)}>List roads and trails</button>
      </div>
      <GroupPicker area={a} groups={groups} edit={edit} report={report} />
    </div>
  );
}

/** Puts an area in a group, a new one, or none. */
function GroupPicker({ area: a, groups, edit, report }: { area: AreaView; groups: GroupView[]; edit: EditArea; report: Report }) {
  const [naming, setNaming] = useState<string | null>(null);
  return (
    <label className="small">
      Group
      {naming === null ? (
        <select value={a.group ?? ''} onChange={(e) => {
          if (e.target.value === '+') setNaming('');
          else edit(a.id, { group: e.target.value || null });
        }}>
          <option value="">None</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          <option value="+">New group…</option>
        </select>
      ) : (
        <form className="row" onSubmit={async (e) => {
          e.preventDefault();
          if (naming.trim() && (await report(trail.addGroup(naming.trim(), [a.id])))) setNaming(null);
        }}>
          <input value={naming} maxLength={100} autoFocus placeholder="Name of the place" aria-label="New group name" onChange={(e) => setNaming(e.target.value)} />
          <button disabled={!naming.trim()}>Make group</button>
          <button type="button" onClick={() => setNaming(null)}>Cancel</button>
        </form>
      )}
    </label>
  );
}

/** A checkbox for each kind of road, showing or hiding it in this area. */
function KindToggles({ area: a, setHide }: { area: AreaView | GroupView; setHide(hide: RoadKind[]): void }) {
  return (
    <div className="kinds">
      {KINDS.map(({ kind, label, color }) => {
        const off = a.hide.includes(kind);
        const len = a.totals[kind];
        if (a.state === 'ready' && !len) return null;
        return (
          <label key={kind} className="kind-head">
            <input type="checkbox" checked={!off} onChange={() => setHide(off ? a.hide.filter((h) => h !== kind) : [...a.hide, kind])} />
            <span className="swatch" style={{ background: color }} />
            {label}
            {len !== undefined && <span className="small"> {distance(len)}</span>}
          </label>
        );
      })}
    </div>
  );
}

/** The roads and trails in one area, or a joined group, over the map. */
export function RoadsPanel({ area, roads, selected, select, go, report, setHide, close }: {
  area: AreaView | GroupView;
  setHide(hide: RoadKind[]): void;
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
        <span className="small">{'members' in area ? `${circles(area.members.length)}, joined` : `${distance(area.radius)} around`}</span>
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
                    <input type="checkbox" checked={!off} onChange={() => setHide(off ? area.hide.filter((h) => h !== kind) : [...area.hide, kind])} />
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
