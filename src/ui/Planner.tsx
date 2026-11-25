import { useEffect, useMemo, useState } from 'react';
import type { AreaView, Bounds, GroupView, MapInfo, PlanNetwork, PlanProgress } from '../core/api.ts';
import { bandLabels, type Config } from '../core/config.ts';
import { DESCENT_DEFAULTS, type DescentWish } from '../core/descent.ts';
import { insideAny } from '../core/shapes.ts';
import type { Level, NewTrail, PlanRequest } from '../core/planner.ts';
import { height, km, type PlannedRoute } from '../core/route.ts';
import { distance, KINDS, type RoadKind } from '../core/roads.ts';
import { trail } from './api.ts';
import type { Bundled } from './mapstyle.ts';
import { PlanMap } from './PlanMap.tsx';
import { planStyle, ROUTE_COLORS, RIDDEN_COLOR, RIDDEN_DARK, START_COLOR, FINISH_COLOR, type RiddenLook } from './planstyle.ts';
import { pointAt, Profile } from './Profile.tsx';
import { areaName, sizeLabel } from './Roads.tsx';

type Step = 1 | 2 | 3 | 4;
const NEW_TRAIL: { id: NewTrail; label: string; note: string }[] = [
  { id: 'little', label: 'A little', note: 'mostly trails you know' },
  { id: 'some', label: 'Some', note: 'about a quarter to a half new' },
  { id: 'lots', label: 'Lots', note: 'mostly new, still joined up by known ones' },
];
const pct = (x: number) => `${Math.round(x * 100)}%`;
const LEVELS: Level[] = ['Easy', 'Moderate', 'Hard', 'Very hard'];
/** How paths you have ridden look on the planner's map. Remembered on this computer. */
const RIDDEN_KEY = 'planner.ridden';
function savedLook(): RiddenLook {
  try {
    const v = localStorage.getItem(RIDDEN_KEY);
    return v === 'dark' || v === 'hide' || v === 'heatmap' ? v : 'show';
  } catch {
    return 'show';
  }
}

/** The route planner: a separate mode, in steps, over its own map. */
export function Planner({ config, maps, bundled, areas, groups, exit, showRoutes }: {
  config: Config;
  maps: Record<string, MapInfo>;
  bundled: Bundled;
  areas: AreaView[];
  groups: GroupView[];
  exit(): void;
  showRoutes(): void;
}) {
  const [step, setStep] = useState<Step>(1);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(areas.filter((a) => a.on && a.state === 'ready').map((a) => a.id)));
  const [net, setNet] = useState<PlanNetwork | null>(null);
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const [busy, setBusy] = useState<'prepare' | 'plan' | 'magic' | 'again' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loop, setLoop] = useState(true);
  const [start, setStart] = useState<[number, number] | null>(null);
  const [finish, setFinish] = useState<[number, number] | null>(null);
  const [clicking, setClicking] = useState<'start' | 'finish' | null>(null);
  const [dist, setDist] = useState('25');
  const [distUnit, setDistUnit] = useState<'km' | 'mi'>('km');
  const [climb, setClimb] = useState('');
  const [climbUnit, setClimbUnit] = useState<'m' | 'ft'>('m');
  const [maxDown, setMaxDown] = useState('');
  const [maxUp, setMaxUp] = useState('');
  const [difficulty, setDifficulty] = useState<Level | null>(null);
  const [tolerance, setTolerance] = useState('5');
  /** Step 3 shows the magic planner's few settings, or all of them. */
  const [magicMode, setMagicMode] = useState(false);
  const [ridden, setRidden] = useState<RiddenLook>(savedLook);
  /** How the routes shown were asked for, so a new set can be asked for the same way. */
  const [asked, setAsked] = useState<{ magic: boolean; variant: number; seen: string[] } | null>(null);
  const [newTrail, setNewTrail] = useState<NewTrail>('some');
  const [kinds, setKinds] = useState<RoadKind[]>(['trail', 'track', 'cycleway', 'road']);
  const [allowRestricted, setAllowRestricted] = useState(false);
  const [favorites, setFavorites] = useState(false);
  /** A long descent the routes must include, and its rules. */
  const [descentOn, setDescentOn] = useState(false);
  const [descentLen, setDescentLen] = useState('10');
  const [descentClimb, setDescentClimb] = useState(String(DESCENT_DEFAULTS.maxClimb));
  const [descentGrade, setDescentGrade] = useState(String(DESCENT_DEFAULTS.minGrade));
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
  const shapes = useMemo(() => areas.filter((a) => chosen.has(a.id)).map((a) => a.shape), [areas, chosen]);
  const sel = routes.find((r) => r.id === selected) ?? null;
  const style = useMemo(
    () => planStyle({ config, maps, bundled, baseMap, ridden, shapes, network: net?.geojson ?? null, routes, selected, start, finish: loop ? null : finish }),
    [config, maps, bundled, baseMap, ridden, shapes, net, routes, selected, start, finish, loop],
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
    if (!start || !insideAny(shapes, start[0], start[1])) {
      setStart(null);
      setFinish(null);
      setClicking('start');
    }
  };
  const clicked = (at: [number, number]) => {
    if (!insideAny(shapes, at[0], at[1])) return setError('That is outside the chosen areas. Click inside one.');
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
  /** Where and how far: all the magic planner uses. */
  const place = (): { start: [number, number]; finish: [number, number] | null; distance: number } | string => {
    const d = Number(dist) * (distUnit === 'mi' ? 1609.344 : 1000);
    if (!start) return 'Place a start on the map first.';
    if (!loop && !finish) return 'Place a finish on the map, or choose a loop.';
    if (!(d >= 500 && d <= 300_000)) return 'Choose a distance from 0.5 to 300 km (0.3 to 186 mi).';
    return { start, finish: loop ? null : finish, distance: Math.round(d) };
  };
  /** The long descent asked for, checked: null when off, or what is wrong. */
  const descent = (): DescentWish | null | string => {
    if (!descentOn) return null;
    const length = Number(descentLen) * (distUnit === 'mi' ? 1609.344 : 1000);
    if (descentLen.trim() === '' || !(length >= 500 && length <= 100_000)) return 'Choose a descent length from 0.5 to 100 km (0.3 to 62 mi).';
    const maxClimb = Number(descentClimb);
    if (descentClimb.trim() === '' || !(maxClimb >= 0 && maxClimb <= 500)) return 'Choose the most the descent may climb, from 0 to 500 m.';
    const minGrade = Number(descentGrade);
    if (descentGrade.trim() === '' || !(minGrade >= DESCENT_DEFAULTS.minGrade && minGrade <= 50)) return `Choose the descent's average steepness, from ${DESCENT_DEFAULTS.minGrade} to 50%.`;
    return { length: Math.round(length), maxClimb, minGrade };
  };
  const request = (): PlanRequest | string => {
    const p = place();
    if (typeof p === 'string') return p;
    const d = p.distance;
    const c = climb.trim() === '' ? null : Number(climb) / (climbUnit === 'ft' ? 3.28084 : 1);
    if (c !== null && !(c >= 0 && c <= 10_000)) return 'Climbing should be a number, or empty.';
    const md = maxDown.trim() === '' ? null : Number(maxDown);
    if (md !== null && !(md >= 1 && md <= 100)) return 'Steepest descent should be a number from 1 to 100%, or empty.';
    const mu = maxUp.trim() === '' ? null : Number(maxUp);
    if (mu !== null && !(mu >= 1 && mu <= 100)) return 'Steepest climb should be a number from 1 to 100%, or empty.';
    if (!kinds.length) return 'Choose at least one kind of path.';
    const tol = Number(tolerance) * (distUnit === 'mi' ? 1609.344 : 1000);
    if (tolerance.trim() === '' || !(tol >= 0 && tol <= 100_000)) return 'Choose how far off the distance may be, from 0 to 100 km (62 mi).';
    const ds = descent();
    if (typeof ds === 'string') return ds;
    return { ...p, tolerance: Math.round(tol), climb: c === null ? null : Math.round(c), newTrail, kinds, allowRestricted, maxDown: md, maxUp: mu, favorites, descent: ds };
  };
  /** Plans routes, or magic ones. `again` asks for a new set, leaving out the ones shown so far. */
  const plan = async (magic: boolean, again = false) => {
    // Magic needs only where and how far; the rest of the form doesn't count.
    const req = magic ? place() : request();
    if (typeof req === 'string') return setError(req);
    if (!net) return;
    const tol = Number(tolerance) * (distUnit === 'mi' ? 1609.344 : 1000);
    if (magic && !difficulty) return setError('Choose a difficulty for magic routes.');
    if (magic && !(tol >= 0 && tol <= 100_000)) return setError('Choose how far off the distance may be, from 0 to 100 km (62 mi).');
    const ds = descent();
    if (typeof ds === 'string') return setError(ds);
    const more = again && asked ? { variant: asked.variant + 1, seen: [...asked.seen, ...routes.map((r) => r.id)] } : { variant: 0, seen: [] };
    setBusy(magic ? 'magic' : again ? 'again' : 'plan');
    setError(null);
    const r = magic
      ? await trail.planMagic(net.key, { start: req.start, finish: req.finish, distance: req.distance, tolerance: Math.round(tol), difficulty: difficulty!, favorites, descent: ds }, more)
      : await trail.planRoutes(net.key, req as PlanRequest, { ...more, difficulty });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setAsked({ magic, ...more });
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
                <p className="small">Choose the areas to plan in. Routes stay inside them.</p>
                {areas.length === 0 && <p className="small">Draw circles or rectangles on the main map first, under Roads and trails.</p>}
                <ul className="choose">
                  {areas.flatMap((a) => {
                    const g = groups.find((x) => x.id === a.group);
                    const choose = (ids: string[], on: boolean) => setChosen((s) => {
                      const n = new Set(s);
                      for (const id of ids) if (on) n.add(id); else n.delete(id);
                      return n;
                    });
                    const row = (x: AreaView) => (
                      <li key={x.id}>
                        <label>
                          <input type="checkbox" disabled={x.state !== 'ready'} checked={chosen.has(x.id)} onChange={(e) => choose([x.id], e.target.checked)} />
                          {' '}{areaName(x)} <span className="small">{sizeLabel(x.shape)}{x.state !== 'ready' ? ' · still downloading' : ''}</span>
                        </label>
                      </li>
                    );
                    if (!g) return [row(a)];
                    if (g.members[0] !== a.id) return [];
                    // A group is chosen whole: its areas that are ready.
                    const ms = areas.filter((m) => m.group === g.id);
                    const ready = ms.filter((m) => m.state === 'ready').map((m) => m.id);
                    return [
                      <li key={g.id}>
                        <label>
                          <input type="checkbox" disabled={!ready.length} checked={ready.length > 0 && ready.every((id) => chosen.has(id))} onChange={(e) => choose(ready, e.target.checked)} />
                          {' '}{g.name} <span className="small">{ms.length} shape{ms.length === 1 ? '' : 's'}{ready.length < ms.length ? ' · still downloading' : ''}</span>
                        </label>
                        {!g.joined && <ul className="choose nested">{ms.map(row)}</ul>}
                      </li>,
                    ];
                  })}
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
            {head(3, 'Your ride', magicMode ? `✨ ${dist} ± ${tolerance} ${distUnit}, ${(difficulty ?? 'any').toLowerCase()}${favorites ? ', with favourites' : ''}${descentOn ? `, ${descentLen} ${distUnit} descent` : ''}` : `${dist} ± ${tolerance} ${distUnit}${climb ? `, ${climb} ${climbUnit} up` : ''}${difficulty ? `, ${difficulty.toLowerCase()}` : ''}${maxUp ? `, up ≤ ${maxUp}%` : ''}${maxDown ? `, down ≤ ${maxDown}%` : ''}${favorites ? ', with favourites' : ''}${descentOn ? `, ${descentLen} ${distUnit} descent` : ''}, ${NEW_TRAIL.find((x) => x.id === newTrail)!.label.toLowerCase()} new`)}
            {step === 3 && (
              <form className="form ride" onSubmit={(e) => { e.preventDefault(); void plan(magicMode); }}>
                <div className="choice mode" role="radiogroup" aria-label="Planning">
                  <label><input type="radio" name="mode" checked={!magicMode} onChange={() => setMagicMode(false)} /> Normal</label>
                  <label><input type="radio" name="mode" checked={magicMode} onChange={() => { setMagicMode(true); if (!difficulty) setDifficulty('Moderate'); }} /> ✨ Magic</label>
                </div>
                {magicMode && (
                  <p className="small magic-note">
                    Only the distance, difficulty, favourite trails and a long descent count. Climbing, steepness and path difficulty
                    are chosen to suit the difficulty you pick, so a long descent is no steeper than it allows, and paths marked
                    private or no bikes are left out.
                  </p>
                )}
                <label>
                  Distance
                  <span className="row distance">
                    <input type="number" min={0.5} step={0.5} value={dist} onChange={(e) => setDist(e.target.value)} aria-label="Distance" />
                    <select value={distUnit} aria-label="Distance unit" onChange={(e) => setDistUnit(e.target.value as 'km' | 'mi')}><option value="km">km</option><option value="mi">mi</option></select>
                    <span>±</span>
                    <input type="number" min={0} step={1} value={tolerance} onChange={(e) => setTolerance(e.target.value)} aria-label="Distance tolerance" />
                    <span>{distUnit}</span>
                  </span>
                  <span className="small">Routes within this much of the distance are fine, closest first. 0 for as close as can be.</span>
                </label>
                <fieldset>
                  <legend>Difficulty</legend>
                  {!magicMode && <label className="inline"><input type="radio" name="difficulty" checked={difficulty === null} onChange={() => setDifficulty(null)} /> Any</label>}
                  {LEVELS.map((l) => (
                    <label key={l} className="inline"><input type="radio" name="difficulty" checked={difficulty === l} onChange={() => setDifficulty(l)} /> {l}</label>
                  ))}
                  <span className="small">{magicMode ? 'Routes are made to suit it.' : 'Routes rated this way are listed first.'}</span>
                </fieldset>
                {!magicMode && (
                  <>
                <label>
                  Climbing <span className="small">(optional)</span>
                  <span className="row">
                    <input type="number" min={0} step={50} value={climb} placeholder="Any" onChange={(e) => setClimb(e.target.value)} aria-label="Climbing" />
                    <select value={climbUnit} aria-label="Climbing unit" onChange={(e) => setClimbUnit(e.target.value as 'm' | 'ft')}><option value="m">m</option><option value="ft">ft</option></select>
                  </span>
                </label>
                <label>
                  Steepest climb <span className="small">(optional)</span>
                  <span className="row">
                    <input type="number" min={1} max={100} step={1} value={maxUp} placeholder="Any" onChange={(e) => setMaxUp(e.target.value)} aria-label="Steepest climb" />
                    <span>%</span>
                  </span>
                  <span className="small">Routes never climb anything steeper, measured over 50 m. Riding down it is fine.</span>
                </label>
                <label>
                  Steepest descent <span className="small">(optional)</span>
                  <span className="row">
                    <input type="number" min={1} max={100} step={1} value={maxDown} placeholder="Any" onChange={(e) => setMaxDown(e.target.value)} aria-label="Steepest descent" />
                    <span>%</span>
                  </span>
                  <span className="small">Routes never go down anything steeper, measured over 50 m. Climbing it is fine. 10% is steep for most riders, 20% very steep.</span>
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
                  </>
                )}
                <label className="fav">
                  <input type="checkbox" checked={favorites} onChange={(e) => setFavorites(e.target.checked)} /> Include my favourite trails
                  <span className="small"> The ones you have ridden most in these areas. Routes go out of their way for them, and ones with more come first.</span>
                </label>
                <label className="fav">
                  <input type="checkbox" checked={descentOn} onChange={(e) => setDescentOn(e.target.checked)} /> Include a long descent
                  <span className="small"> One continuous stretch that keeps going down. If the chosen areas have none that long, you are told the longest there is.</span>
                </label>
                {descentOn && (
                  <div className="descent">
                    <label>
                      Length
                      <span className="row">
                        <input type="number" min={0.5} step={0.5} value={descentLen} onChange={(e) => setDescentLen(e.target.value)} aria-label="Descent length" />
                        <span>{distUnit}</span>
                      </span>
                      <span className="small">At least this long.</span>
                    </label>
                    <label>
                      Most climbing on the way
                      <span className="row">
                        <input type="number" min={0} max={500} step={5} value={descentClimb} onChange={(e) => setDescentClimb(e.target.value)} aria-label="Most climbing on the descent" />
                        <span>m</span>
                      </span>
                      <span className="small">It never climbs more than this above its lowest point so far. Elevation is only good to about 10 m.</span>
                    </label>
                    <label>
                      Average steepness, at least
                      <span className="row">
                        <input type="number" min={DESCENT_DEFAULTS.minGrade} max={50} step={0.5} value={descentGrade} onChange={(e) => setDescentGrade(e.target.value)} aria-label="Descent average steepness" />
                        <span>%</span>
                      </span>
                      <span className="small">Down at least this much on average, so a long gentle valley road doesn&apos;t count.</span>
                    </label>
                  </div>
                )}
                {magicMode ? (
                  <button className="magic-go" disabled={busy !== null || !difficulty}>{busy === 'magic' ? 'Working magic…' : '✨ Magic routes'}</button>
                ) : (
                  <button disabled={busy !== null}>{busy === 'plan' ? 'Planning…' : 'Plan routes'}</button>
                )}
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
                  const tol = Number(tolerance) * (distUnit === 'mi' ? 1609.344 : 1000);
                  const off = routes.length && routes.every((r) => Math.abs(r.stats.distance - want) > Math.max(tol, want * 0.05));
                  return off ? (
                    <p className="small warn" role="status">
                      None of these is within {tolerance} {distUnit} of {km(want)}. {routes.every((r) => r.stats.distance < want) ? 'The chosen areas are too small for that without riding the same paths again: add or grow areas, or ask for less.' : 'The paths here don’t allow a route that short from this start.'}
                    </p>
                  ) : null;
                })()}
                <ol className="route-cards">
                  {routes.map((r, i) => (
                    <RouteCard key={r.id} route={r} color={ROUTE_COLORS[i % ROUTE_COLORS.length]!} on={r.id === selected}
                      select={() => setSelected(r.id)} showProfile={() => { setSelected(r.id); setProfile(true); }} />
                  ))}
                </ol>
                {asked?.magic && difficulty && (() => {
                  const want = Number(dist) * (distUnit === 'mi' ? 1609.344 : 1000), tol = Number(tolerance) * (distUnit === 'mi' ? 1609.344 : 1000);
                  const far = routes.filter((r) => Math.abs(r.stats.distance - want) > tol).length;
                  const other = routes.filter((r) => r.rating.difficulty !== difficulty).length;
                  return far || other ? (
                    <p className="small warn" role="status">
                      Closest that could be found: {[far && `${far} of these ${far === 1 ? 'is' : 'are'} more than ${tolerance} ${distUnit} off`, other && `${other} ${other === 1 ? 'isn’t' : 'aren’t'} rated ${difficulty.toLowerCase()}`].filter(Boolean).join(', and ')}.
                    </p>
                  ) : null;
                })()}
                <button className="primary" disabled={busy !== null} onClick={() => void plan(asked?.magic ?? false, true)}>
                  {busy === 'again' || (busy === 'magic' && asked) ? 'Finding new routes…' : 'Generate new routes'}
                </button>
                <p className="small">A different set{asked?.magic ? ' of magic routes' : ''} from the same request, leaving out the ones shown so far.</p>
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
            {(ridden === 'show' || ridden === 'dark') && <p><span className="swatch" style={{ background: ridden === 'dark' ? RIDDEN_DARK : RIDDEN_COLOR }} /> Ridden</p>}
            {ridden === 'heatmap' && (
              <>
                <p>Ridden, by times ridden:</p>
                <ul className="legend">
                  {config.heatmap.bands.map((b, i) => <li key={b.from}><span style={{ background: b.color, borderColor: config.heatmap.outline }} />{bandLabels(config.heatmap.bands)[i]}</li>)}
                </ul>
              </>
            )}
            <p><span className="swatch dashed" /> {ridden === 'hide' ? 'Paths, by kind' : 'Not ridden yet, by kind'}</p>
            <p><span className="swatch dotted" /> Private or no bikes</p>
            <label><input type="checkbox" checked={baseMap} onChange={(e) => setBaseMap(e.target.checked)} /> Show the base map</label>
            <label>
              Paths you&apos;ve ridden{' '}
              <select value={ridden} aria-label="Paths you've ridden" onChange={(e) => {
                const v = e.target.value as RiddenLook;
                setRidden(v);
                try {
                  localStorage.setItem(RIDDEN_KEY, v);
                } catch {}
              }}>
                <option value="show">Highlight</option>
                <option value="dark">Darken</option>
                <option value="heatmap">Heatmap</option>
                <option value="hide">Hide</option>
              </select>
            </label>
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
        <dt>Steepest</dt><dd>↑ {Math.round(s.maxUp)}% ↓ {Math.round(s.maxDown)}%</dd>
        <dt>New trail</dt><dd>{km(r.fresh)}, {pct(r.fresh / total)}</dd>
        {r.favorite !== undefined && <><dt>Favourites</dt><dd>{km(r.favorite)}, {pct(r.favorite / total)}</dd></>}
        {r.descent && <><dt>Long descent</dt><dd>{km(r.descent.length)}, {height(r.descent.drop)} down, from {km(r.descent.from)}</dd></>}
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
