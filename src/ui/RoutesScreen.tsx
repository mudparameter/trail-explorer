import { useEffect, useMemo, useState } from 'react';
import type { Bounds, MapInfo, RouteDetail } from '../core/api.ts';
import type { Config } from '../core/config.ts';
import { height, heightShort, km, kmShort } from '../core/route.ts';
import type { SavedRoute } from '../core/routes.ts';
import { trail } from './api.ts';
import type { Bundled } from './mapstyle.ts';
import { PlanMap } from './PlanMap.tsx';
import { planStyle } from './planstyle.ts';
import { pointAt, Profile } from './Profile.tsx';

type Col = 'name' | 'loop' | 'distance' | 'gain' | 'loss' | 'steep' | 'difficulty' | 'fresh' | 'created';
const LEVEL = { Easy: 1, Moderate: 2, Hard: 3, 'Very hard': 4 } as const;
const COLS: { id: Col; label: string; value(r: SavedRoute): string | number }[] = [
  { id: 'name', label: 'Name', value: (r) => r.name.toLowerCase() },
  { id: 'loop', label: 'Kind', value: (r) => (r.loop ? 0 : 1) },
  { id: 'distance', label: 'Distance', value: (r) => r.distance },
  { id: 'gain', label: 'Climbing', value: (r) => r.gain },
  { id: 'loss', label: 'Descent', value: (r) => r.loss },
  { id: 'steep', label: 'Steepest', value: (r) => Math.max(r.maxUp, r.maxDown) },
  { id: 'difficulty', label: 'Difficulty', value: (r) => LEVEL[r.difficulty] },
  { id: 'fresh', label: 'New trail', value: (r) => r.fresh },
  { id: 'created', label: 'Created', value: (r) => r.created },
];

/** Saved routes, as a table that sorts by any column. */
export function RoutesScreen({ config, maps, bundled, plan }: { config: Config; maps: Record<string, MapInfo>; bundled: Bundled; plan(): void }) {
  const [routes, setRoutes] = useState<SavedRoute[] | null>(null);
  const [sort, setSort] = useState<{ col: Col; up: boolean }>({ col: 'created', up: false });
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => void trail.getRoutes().then(setRoutes);
  useEffect(load, []);
  const report = async (r: Promise<{ ok: boolean; error?: string }>) => {
    const x = await r;
    setError(x.ok ? null : x.error ?? 'Something went wrong.');
    load();
    return x.ok;
  };

  const sorted = useMemo(() => {
    const c = COLS.find((x) => x.id === sort.col)!;
    return [...(routes ?? [])].sort((a, b) => {
      const va = c.value(a), vb = c.value(b);
      const d = va < vb ? -1 : va > vb ? 1 : 0;
      return (sort.up ? d : -d) || a.id.localeCompare(b.id);
    });
  }, [routes, sort]);
  if (!routes) return null;

  return (
    <main className="page wide routes-page">
      <div className="row top">
        <h1>Saved routes</h1>
        <button onClick={plan}>Plan a route</button>
      </div>
      <p className="small">Routes saved from the route planner. They are kept in the config folder, in routes.json and a GPX file each. Click a column to sort.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {routes.length === 0 ? (
        <p>No routes yet. Open the route planner, plan some routes, and save the ones you like.</p>
      ) : (
        <table className="routes">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.id} aria-sort={sort.col === c.id ? (sort.up ? 'ascending' : 'descending') : 'none'}>
                  <button className="sort" onClick={() => setSort((s) => ({ col: c.id, up: s.col === c.id ? !s.up : c.id === 'name' }))}>
                    {c.label}{sort.col === c.id ? (sort.up ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              ))}
              <th><span className="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} data-route={r.id} className={open === r.id ? 'on' : ''}>
                <td className="name">
                  {editing?.id === r.id ? (
                    <form className="row" onSubmit={async (e) => {
                      e.preventDefault();
                      if (await report(trail.renameRoute(r.id, editing.name))) setEditing(null);
                    }}>
                      <input value={editing.name} maxLength={100} autoFocus aria-label="Route name" onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
                      <button>Save</button>
                    </form>
                  ) : (
                    <button className="link" title="Show this route" onClick={() => setOpen(open === r.id ? null : r.id)}>{r.name}</button>
                  )}
                </td>
                <td>{r.loop ? 'Loop' : 'A to B'}</td>
                <td className="num">{kmShort(r.distance)}</td>
                <td className="num">{heightShort(r.gain)}</td>
                <td className="num">{heightShort(r.loss)}</td>
                <td className="num">↑{Math.round(r.maxUp)}% ↓{Math.round(r.maxDown)}%</td>
                <td><span className={`badge level-${LEVEL[r.difficulty]}`}>{r.difficulty}</span></td>
                <td className="num">{kmShort(r.fresh)}</td>
                <td className="num">{new Date(r.created).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                <td className="actions">
                  {confirm === r.id ? (
                    <span className="row small" role="alert">
                      Delete?
                      <button onClick={() => { setConfirm(null); if (open === r.id) setOpen(null); void report(trail.deleteRoute(r.id)); }}>Delete</button>
                      <button onClick={() => setConfirm(null)}>Keep</button>
                    </span>
                  ) : (
                    <span className="row">
                      <button className="link" onClick={() => setEditing({ id: r.id, name: r.name })}>Rename</button>
                      <button className="link" onClick={() => void report(trail.exportRoute(r.id))}>Download .gpx</button>
                      <button className="link" onClick={() => setConfirm(r.id)}>Delete</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <RouteView id={open} config={config} maps={maps} bundled={bundled} close={() => setOpen(null)} />}
    </main>
  );
}

/** One saved route on a map, with its elevation profile. */
function RouteView({ id, config, maps, bundled, close }: { id: string; config: Config; maps: Record<string, MapInfo>; bundled: Bundled; close(): void }) {
  const [d, setD] = useState<RouteDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  useEffect(() => {
    setD(null);
    void trail.getRoute(id).then((r) => (r.ok ? setD(r.value) : setErr(r.error)));
  }, [id]);
  const style = useMemo(
    () => planStyle({
      config, maps, bundled, baseMap: true, circles: [], network: null, routes: d ? [{ id, line: d.line }] : [], selected: id,
      start: d?.line[0] ? [d.line[0][0], d.line[0][1]] : null, finish: d && !d.route.loop ? [d.line[d.line.length - 1]![0], d.line[d.line.length - 1]![1]] : null,
    }),
    [config, maps, bundled, d, id],
  );
  const bounds = useMemo((): Bounds | null => {
    if (!d?.line.length) return null;
    const xs = d.line.map((p) => p[0]), ys = d.line.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }, [d]);
  return (
    <section className="route-view" aria-label="Route">
      <header className="row top">
        <h2>{d?.route.name ?? 'Route'}</h2>
        <button className="close" aria-label="Close the route" onClick={close}>×</button>
      </header>
      {err && <p className="error">{err}</p>}
      {d && (
        <>
          <p className="small">{km(d.stats.distance)} · ↑ {height(d.stats.gain)} · ↓ {height(d.stats.loss)} · {d.route.difficulty}</p>
          <div className="route-map"><PlanMap style={style} bounds={bounds} clicking={null} onClick={() => {}} hover={hover} /></div>
          <Profile stats={d.stats} onHover={(x) => setHover(x === null ? null : pointAt(d.line, x))} />
        </>
      )}
    </section>
  );
}
