import { useEffect, useMemo, useState } from 'react';
import type { AreaView, Bounds, MapInfo, PlanNetwork, PlanProgress } from '../core/api.ts';
import type { Config } from '../core/config.ts';
import { insideAny } from '../core/network.ts';
import type { NewTrail, PlanRequest } from '../core/planner.ts';
import { height, km, type PlannedRoute } from '../core/route.ts';
import { distance, KINDS, type RoadKind } from '../core/roads.ts';
import { trail } from './api.ts';
import type { Bundled } from './mapstyle.ts';
import { PlanMap } from './PlanMap.tsx';
import { planStyle, ROUTE_COLORS, RIDDEN_COLOR, START_COLOR, FINISH_COLOR } from './planstyle.ts';
import { pointAt, Profile } from './Profile.tsx';
import { areaName } from './Roads.tsx';

type Step = 1 | 2 | 3 | 4;
const NEW_TRAIL: { id: NewTrail; label: string; note: string }[] = [
  { id: 'little', label: 'A little', note: 'mostly trails you know' },
  { id: 'some', label: 'Some', note: 'about a quarter to a half new' },
  { id: 'lots', label: 'Lots', note: 'mostly new, still joined up by known ones' },
];
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The route planner: a separate mode, in steps, over its own map. */
export function Planner({ config, maps, bundled, areas, exit, showRoutes }: {
  config: Config;
  maps: Record<string, MapInfo>;
  bundled: Bundled;
  areas: AreaView[];
  exit(): void;
  showRoutes(): void;
}) {
  const [step, setStep] = useState<Step>(1);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(areas.filter((a) => a.on && a.state === 'ready').map((a) => a.id)));
  const [net, setNet] = useState<PlanNetwork | null>(null);
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const [busy, setBusy] = useState<'prepare' | 'plan' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loop, setLoop] = useState(true);
  const [start, setStart] = useState<[number, number] | null>(null);
  const [finish, setFinish] = useState<[number, number] | null>(null);
  const [clicking, setClicking] = useState<'start' | 'finish' | null>(null);
  const [dist, setDist] = useState('25');
  const [distUnit, setDistUnit] = useState<'km' | 'mi'>('km');
  const [climb, setClimb] = useState('');
  const [climbUnit, setClimbUnit] = useState<'m' | 'ft'>('m');
  const [newTrail, setNewTrail] = useState<NewTrail>('some');
  const [kinds, setKinds] = useState<RoadKind[]>(['trail', 'track', 'cycleway', 'road']);
  const [allowRestricted, setAllowRestricted] = useState(false);
  const [routes, setRoutes] = useState<PlannedRoute[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [profile, setProfile] = useState(false);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [baseMap, setBaseMap] = useState(false);
  const [fit, setFit] = useState<Bounds | null>(null);

  useEffect(() => trail.onPlanProgress(setProgress), []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setClicking(null);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const usable = areas.filter((a) => a.state === 'ready');
  const circles = useMemo(() => areas.filter((a) => chosen.has(a.id)).map((a) => ({ center: a.center, radius: a.radius })), [areas, chosen]);
  const sel = routes.find((r) => r.id === selected) ?? null;
  const style = useMemo(
    () => planStyle({ config, maps, bundled, baseMap, circles, network: net?.geojson ?? null, routes, selected, start, finish: loop ? null : finish }),
    [config, maps, bundled, baseMap, circles, net, routes, selected, start, finish, loop],
  );

  const prepare = async () => {
    setBusy('prepare');
    setError(null);
    setProgress(null);
    setRoutes([]);
    setSelected(null);
    const r = await trail.planPrepare([...chosen]);
    setBusy(null);
    setProgress(null);
    if (!r.ok) return setError(r.error);
    setNet(r.value);
    setFit(r.value.bounds);
    setStep(2);
    if (!start || !insideAny(circles, start[0], start[1])) {
      setStart(null);
      setFinish(null);
      setClicking('start');
    }
  };
  const clicked = (at: [number, number]) => {
    if (!insideAny(circles, at[0], at[1])) return setError('That is outside the chosen areas. Click inside a circle.');
    setError(null);
    if (clicking === 'start') {
      setStart(at);
      if (!loop && !finish) setClicking('finish');
      else {
        setClicking(null);
        if (step === 2) setStep(3);
      }
    } else if (clicking === 'finish') {
      setFinish(at);
      setClicking(null);
      if (step === 2) setStep(3);
    }
  };
  const request = (): PlanRequest | string => {
    const d = Number(dist) * (distUnit === 'mi' ? 1609.344 : 1000);
    if (!start) return 'Place a start on the map first.';
    if (!loop && !finish) return 'Place a finish on the map, or choose a loop.';
    if (!(d >= 500 && d <= 300_000)) return 'Choose a distance from 0.5 to 300 km (0.3 to 186 mi).';
    const c = climb.trim() === '' ? null : Number(climb) / (climbUnit === 'ft' ? 3.28084 : 1);
    if (c !== null && !(c >= 0 && c <= 10_000)) return 'Climbing should be a number, or empty.';
    if (!kinds.length) return 'Choose at least one kind of path.';
    return { start, finish: loop ? null : finish, distance: Math.round(d), climb: c === null ? null : Math.round(c), newTrail, kinds, allowRestricted };
  };
  const plan = async () => {
    const req = request();
    if (typeof req === 'string') return setError(req);
    if (!net) return;
    setBusy('plan');
    setError(null);
    const r = await trail.planRoutes(net.key, req);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setRoutes(r.value);
    setSelected(r.value[0]?.id ?? null);
    setStep(4);
  };

  const head = (n: Step, title: string, summary: React.ReactNode) => (
    <div className={`step-head${step === n ? ' current' : ''}${step < n ? ' later' : ''}`}>
      <span className="num">{n}</span>
      <strong>{title}</strong>
      {step > n && (
        <>
          <span className="small summary">{summary}</span>
          <button className="link small" onClick={() => setStep(n)}>Change</button>
        </>
      )}
    </div>
  );

  return (
    <div className="planner">
      <header className="mode-bar">
        <strong>Route planner</strong>
        <span className="small">Routes in your areas that mix trails you know with ones you don't. Nothing here changes the main map.</span>
        <button onClick={showRoutes}>Saved routes</button>
        <button onClick={exit}>← Back to the map</button>
      </header>
      <div className="planner-body">
        <aside className="side plan-side" aria-label="Route planner steps">
          <section className="step">
            {head(1, 'Areas', `${chosen.size} area${chosen.size === 1 ? '' : 's'}${net ? ` · ${distance(net.total)} of paths, ${pct(net.ridden / (net.total || 1))} ridden` : ''}`)}
            {step === 1 && (
              <>
                <p className="small">Choose the circles to plan in. Routes stay inside them.</p>
                {areas.length === 0 && <p className="small">Draw circles on the main map first, under Roads and trails.</p>}
                <ul className="choose">
                  {areas.map((a) => (
                    <li key={a.id}>
                      <label>
                        <input type="checkbox" disabled={a.state !== 'ready'} checked={chosen.has(a.id)}
                          onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; })} />
                        {' '}{areaName(a)} <span className="small">{distance(a.radius)}{a.state !== 'ready' ? ' · still downloading' : ''}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <button disabled={!chosen.size || busy !== null || !usable.length} onClick={() => void prepare()}>
                  {busy === 'prepare' ? 'Getting ready…' : 'Use these areas'}
                </button>
                {busy === 'prepare' && progress && (
                  <p className="small" role="status">
                    {progress.stage === 'roads' ? 'Reading paths…' : progress.stage === 'elevation' ? `Downloading elevation: ${progress.done} of ${progress.total} tiles` : 'Finding which paths you have ridden…'}
                  </p>
                )}
              </>
            )}
            {net && net.missingElevation > 0 && <p className="small error">Elevation for {net.missingElevation} map tile{net.missingElevation === 1 ? '' : 's'} could not be downloaded, so climbing there is unknown.</p>}
          </section>

          <section className="step">
            {head(2, 'Start and finish', loop ? 'Loop' : 'Start to finish')}
            {step === 2 && (
              <>
                <div className="choice" role="radiogroup" aria-label="Kind of route">
                  <label><input type="radio" checked={loop} onChange={() => { setLoop(true); if (clicking === 'finish') setClicking(null); }} /> Loop, back to the start</label>
                  <label><input type="radio" checked={!loop} onChange={() => { setLoop(false); if (start && !finish) setClicking('finish'); }} /> From a start to a finish</label>
                </div>
                <p className="small" role="status">
                  {clicking === 'start' ? 'Click the map to place the start.' : clicking === 'finish' ? 'Now click the map to place the finish.' : 'Placed. Move a point, or go on.'}
                </p>
                <div className="row">
                  <button onClick={() => setClicking('start')} disabled={clicking === 'start'}><span className="dot" style={{ background: START_COLOR }} /> {start ? 'Move start' : 'Place start'}</button>
                  {!loop && <button onClick={() => setClicking('finish')} disabled={clicking === 'finish'}><span className="dot" style={{ background: FINISH_COLOR }} /> {finish ? 'Move finish' : 'Place finish'}</button>}
                </div>
                <button disabled={!start || (!loop && !finish)} onClick={() => { setClicking(null); setStep(3); }}>Next</button>
              </>
            )}
          </section>

          <section className="step">
            {head(3, 'Your ride', `${dist} ${distUnit}${climb ? `, ${climb} ${climbUnit} up` : ''}, ${NEW_TRAIL.find((x) => x.id === newTrail)!.label.toLowerCase()} new`)}
            {step === 3 && (
              <form className="form ride" onSubmit={(e) => { e.preventDefault(); void plan(); }}>
                <label>
                  Distance
                  <span className="row">
                    <input type="number" min={0.5} step={0.5} value={dist} onChange={(e) => setDist(e.target.value)} aria-label="Distance" />
                    <select value={distUnit} aria-label="Distance unit" onChange={(e) => setDistUnit(e.target.value as 'km' | 'mi')}><option value="km">km</option><option value="mi">mi</option></select>
                  </span>
                </label>
                <label>
                  Climbing <span className="small">(optional)</span>
                  <span className="row">
                    <input type="number" min={0} step={50} value={climb} placeholder="Any" onChange={(e) => setClimb(e.target.value)} aria-label="Climbing" />
                    <select value={climbUnit} aria-label="Climbing unit" onChange={(e) => setClimbUnit(e.target.value as 'm' | 'ft')}><option value="m">m</option><option value="ft">ft</option></select>
                  </span>
                </label>
                <fieldset>
                  <legend>New trail</legend>
                  {NEW_TRAIL.map((x) => (
                    <label key={x.id} className="inline"><input type="radio" name="new" checked={newTrail === x.id} onChange={() => setNewTrail(x.id)} /> {x.label} <span className="small">{x.note}</span></label>
                  ))}
                </fieldset>
                <fieldset>
                  <legend>Paths to use</legend>
                  {KINDS.map((k) => (
                    <label key={k.kind} className="inline">
                      <input type="checkbox" checked={kinds.includes(k.kind)} onChange={(e) => setKinds((ks) => (e.target.checked ? [...ks, k.kind] : ks.filter((x) => x !== k.kind)))} />
                      <span className="swatch" style={{ background: k.color }} /> {k.label}
                    </label>
                  ))}
                  <label className="inline"><input type="checkbox" checked={allowRestricted} onChange={(e) => setAllowRestricted(e.target.checked)} /> Allow paths marked private or no bikes</label>
                </fieldset>
                <button disabled={busy !== null}>{busy === 'plan' ? 'Planning…' : 'Plan routes'}</button>
              </form>
            )}
          </section>

          <section className="step">
            {head(4, 'Pick a route', `${routes.length} routes`)}
            {step === 4 && (
              <>
                <p className="small">Click a route to see it. Save the ones you like; they go to Saved routes.</p>
                {(() => {
                  const want = Number(dist) * (distUnit === 'mi' ? 1609.344 : 1000);
                  const off = routes.length && routes.every((r) => Math.abs(r.stats.distance - want) / want > 0.15);
                  return off ? (
                    <p className="small warn" role="status">
                      None of these is close to {km(want)}. {routes.every((r) => r.stats.distance < want) ? 'The chosen areas are too small for that without riding the same paths again: add or grow areas, or ask for less.' : 'The paths here don’t allow a route that short from this start.'}
                    </p>
                  ) : null;
                })()}
                <ol className="route-cards">
                  {routes.map((r, i) => (
                    <RouteCard key={r.id} route={r} color={ROUTE_COLORS[i % ROUTE_COLORS.length]!} on={r.id === selected}
                      select={() => setSelected(r.id)} showProfile={() => { setSelected(r.id); setProfile(true); }} />
                  ))}
                </ol>
                <div className="row">
                  <button onClick={() => setStep(3)}>Change the ride</button>
                  <button onClick={() => setStep(2)}>Move start or finish</button>
                </div>
              </>
            )}
          </section>

          {error && <p className="error" role="alert">{error}</p>}
          <div className="plan-key small">
            <h2>Map key</h2>
            <p><span className="swatch" style={{ background: RIDDEN_COLOR }} /> Ridden</p>
            <p><span className="swatch dashed" /> Not ridden yet, by kind</p>
            <p><span className="swatch dotted" /> Private or no bikes</p>
            <label><input type="checkbox" checked={baseMap} onChange={(e) => setBaseMap(e.target.checked)} /> Show the base map</label>
            <p className="credit">Paths © OpenStreetMap contributors. Elevation: Mapzen Terrain Tiles (USGS, SRTM and others).</p>
          </div>
        </aside>
        <div className="main">
          {clicking && <div className="notice" role="status">Click the map to place the {clicking}. <button onClick={() => setClicking(null)}>Cancel</button></div>}
          <div className="map-wrap">
            <PlanMap style={style} bounds={fit} clicking={clicking} onClick={clicked} onPickRoute={setSelected} hover={hover} />
          </div>
          {sel && profile && (
            <section className="profile-panel" aria-label="Elevation profile">
              <header className="row top">
                <strong>{sel.name}</strong>
                <span className="small">↑ {height(sel.stats.gain)} · ↓ {height(sel.stats.loss)}</span>
                <button className="close" aria-label="Close the profile" onClick={() => { setProfile(false); setHover(null); }}>×</button>
              </header>
              <Profile stats={sel.stats} onHover={(d) => setHover(d === null ? null : pointAt(sel.line, d))} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** One planned route: its rating, stats, warnings, and saving it. */
function RouteCard({ route: r, color, on, select, showProfile }: { route: PlannedRoute; color: string; on: boolean; select(): void; showProfile(): void }) {
  const [name, setName] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const s = r.stats;
  const total = s.distance || 1;
  const mix = KINDS.filter((k) => r.kinds[k.kind]).map((k) => `${k.label.split(' ')[0]} ${pct(r.kinds[k.kind]! / total)}`).join(' · ');
  const save = async () => {
    const res = await trail.saveRoute(r.id, name ?? r.name);
    if (!res.ok) return setErr(res.error);
    setSaved(res.value.name);
    setName(null);
  };
  return (
    <li className={`route-card${on ? ' on' : ''}`} data-route={r.id}>
      <button className="pick" onClick={select} aria-pressed={on}>
        <span className="swatch wide" style={{ background: color }} />
        <span className="name">{r.name}</span>
        <span className={`badge level-${r.rating.level}`}>{r.rating.difficulty}</span>
      </button>
      <dl className="stats">
        <dt>Distance</dt><dd>{km(s.distance)}</dd>
        <dt>Climbing</dt><dd>↑ {height(s.gain)}</dd>
        <dt>Descent</dt><dd>↓ {height(s.loss)}</dd>
        <dt>New trail</dt><dd>{km(r.fresh)}, {pct(r.fresh / total)}</dd>
      </dl>
      <p className="small">{mix}</p>
      <p className="small">Why {r.rating.difficulty.toLowerCase()}: {r.rating.reasons.join(', ')}.</p>
      {s.steepUp.length > 0 && <p className="small warn">Very steep climbing: {s.steepUp.length} part{s.steepUp.length === 1 ? '' : 's'}, up to {Math.round(s.maxUp)}%</p>}
      {s.steepDown.length > 0 && <p className="small warn">Very steep descending: {s.steepDown.length} part{s.steepDown.length === 1 ? '' : 's'}, down to {Math.round(s.maxDown)}%</p>}
      {r.restricted && <p className="small warn">Uses paths marked private or no bikes.</p>}
      {r.repeated > 200 && <p className="small">Rides {km(r.repeated)} of it twice.</p>}
      <div className="row">
        <button className="link" onClick={showProfile}>Elevation profile</button>
        {saved ? (
          <span className="small">Saved as “{saved}”.</span>
        ) : name === null ? (
          <button className="link" onClick={() => setName(r.name)}>Save…</button>
        ) : null}
      </div>
      {name !== null && !saved && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input value={name} maxLength={100} autoFocus aria-label="Route name" onChange={(e) => setName(e.target.value)} />
          <button>Save</button>
          <button type="button" onClick={() => setName(null)}>Cancel</button>
        </form>
      )}
      {err && <p className="small error">{err}</p>}
    </li>
  );
}
