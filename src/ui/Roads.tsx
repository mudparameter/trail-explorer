import { useEffect, useRef } from 'react';
import type { Bounds } from '../core/api.ts';
import { distance, KINDS, OSM_ATTRIBUTION, type Road, type RoadKind } from '../core/roads.ts';

/** A search for roads and trails in a circle. */
export interface Search {
  center: [number, number];
  radius: number;
  state: 'loading' | 'done' | 'error';
  roads: Road[];
  error?: string;
}

interface Props {
  search: Search;
  selected: string | null;
  select(key: string | null): void;
  hidden: RoadKind[];
  setHidden(k: RoadKind[]): void;
  go(b: Bounds): void;
  retry(): void;
  redraw(): void;
  close(): void;
}

export function RoadsPanel({ search, selected, select, hidden, setHidden, go, retry, redraw, close }: Props) {
  const list = useRef<HTMLDivElement>(null);
  // A road picked on the map scrolls into view here.
  useEffect(() => {
    if (!selected) return;
    list.current?.querySelector(`[data-key="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const total = search.roads.reduce((n, r) => n + r.length, 0);

  return (
    <section className="roads" aria-label="Roads and trails">
      <header>
        <strong>Roads and trails</strong>
        <span className="small">within {distance(search.radius)}</span>
        <button className="close" aria-label="Clear the search" title="Clear" onClick={close}>×</button>
      </header>
      {search.state === 'loading' && <p className="small" role="status">Searching OpenStreetMap…</p>}
      {search.state === 'error' && (
        <div role="alert">
          <p className="error">{search.error}</p>
          <div className="row"><button onClick={retry}>Try again</button><button onClick={redraw}>Draw another circle</button></div>
        </div>
      )}
      {search.state === 'done' && (
        <>
          <p className="small">
            {search.roads.length ? `${distance(total)} in all. Click a name to show it, or a line on the map.` : 'Nothing found in this circle.'}
          </p>
          <div className="roads-list" ref={list}>
            {KINDS.map(({ kind, label, color }) => {
              const rs = search.roads.filter((r) => r.kind === kind);
              if (!rs.length) return null;
              const off = hidden.includes(kind);
              return (
                <div key={kind} className="kind">
                  <label className="kind-head">
                    <input type="checkbox" checked={!off} onChange={() => setHidden(off ? hidden.filter((h) => h !== kind) : [...hidden, kind])} />
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
          <div className="row"><button onClick={redraw}>Draw another circle</button></div>
        </>
      )}
      <p className="small credit">Data {OSM_ATTRIBUTION}</p>
    </section>
  );
}
