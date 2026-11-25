import assert from 'node:assert/strict';
import test from 'node:test';
import { addHeights, findDescents, type DescentWish } from '../src/core/descent.ts';
import { buildNetwork, type Network } from '../src/core/network.ts';
import { Planner, type PlanRequest } from '../src/core/planner.ts';
import { describe as describeRoute, elevated } from '../src/core/route.ts';
import type { OsmWay } from '../src/core/roads.ts';
import { M_PER_DEG } from '../src/core/track.ts';

const C: [number, number] = [-0.47, 39.7];
const K = M_PER_DEG * Math.cos((C[1] * Math.PI) / 180);
const P = (x: number, y: number): [number, number] => [C[0] + x / K, C[1] + y / M_PER_DEG];
const yOf = (lat: number) => (lat - C[1]) * M_PER_DEG;

/** A grid of paths 200 m apart, 4 km across, with a road along row `road` if given. */
function grid(road: number | null = null, n = 21, gap = 200): OsmWay[] {
  const id = (i: number, j: number) => i * 1000 + j + 1;
  const half = ((n - 1) * gap) / 2;
  const ways: OsmWay[] = [];
  for (let j = 0; j < n; j++) {
    const nodes = Array.from({ length: n }, (_, i) => id(i, j));
    ways.push({ id: 10_000 + j, tags: { highway: j === road ? 'tertiary' : 'path' }, nodes, coords: nodes.map((_, i) => P(i * gap - half, j * gap - half)) });
  }
  for (let i = 0; i < n; i++) {
    const nodes = Array.from({ length: n }, (_, j) => id(i, j));
    ways.push({ id: 20_000 + i, tags: { highway: 'path' }, nodes, coords: nodes.map((_, j) => P(i * gap - half, j * gap - half)) });
  }
  return ways;
}
const AREA = { kind: 'rect' as const, box: [...P(-2100, -2100), ...P(2100, 2100)] as [number, number, number, number] };

/** Down 5% going south: 200 m from the north edge to the south edge. */
const slope = (_lon: number, lat: number) => 1000 + 0.05 * yOf(lat);
/** The same, with a 60 m ridge across the middle. */
const ridge = (lon: number, lat: number) => slope(lon, lat) + 60 * Math.exp(-((yOf(lat) / 150) ** 2));

function net(at: (lon: number, lat: number) => number, road: number | null = null): Network {
  const n = buildNetwork(grid(road), [AREA]);
  addHeights(n, at);
  return n;
}
const wish = (length: number, more: Partial<DescentWish> = {}): DescentWish => ({ length, maxClimb: 25, minGrade: 3, ...more });
const all = () => 'ok' as const;
const lineOf = (n: Network, steps: { edge: number; back: boolean }[]) => steps.flatMap(({ edge, back }, i) => {
  const e = n.edges[edge]!;
  const pts: [number, number][] = [];
  for (let k = 0; k < e.coords.length; k += 2) pts.push([e.coords[k]!, e.coords[k + 1]!]);
  if (back) pts.reverse();
  return i ? pts.slice(1) : pts;
});

test('descents keep going down, as steep as asked on average, and as long as the slope allows', () => {
  const n = net(slope);
  const { found, longest } = findDescents(n, all, wish(3000));
  assert.ok(found.length > 0);
  // 200 m of drop at 3% or more is at most 6.67 km of path; straight down the slope is 4 km.
  assert.ok(longest >= 4000 && longest <= 200 / 0.03 + 1, String(longest));
  for (const d of found) {
    assert.ok(d.length >= 3000);
    assert.ok(d.drop / d.length >= 0.03 - 1e-9, `${d.drop} over ${d.length}`);
    // One line, end to end, never climbing.
    const line = lineOf(n, d.steps);
    for (let i = 1; i < d.steps.length; i++) {
      const a = d.steps[i - 1]!, b = d.steps[i]!;
      const ea = n.edges[a.edge]!, eb = n.edges[b.edge]!;
      assert.equal(a.back ? ea.a : ea.b, b.back ? eb.b : eb.a, 'joined end to end');
    }
    const h = line.map(([x, y]) => slope(x, y));
    for (let i = 1; i < h.length; i++) assert.ok(h[i]! <= h[i - 1]! + 1e-6);
  }
  // A steeper average leaves only shorter ones.
  assert.ok(findDescents(n, all, wish(3000, { minGrade: 4.5 })).longest < longest);
});

test('a climb bigger than allowed breaks a descent, and a bigger allowance lets it through', () => {
  // One path straight south over the ridge, in 200 m pieces so each joint is a junction: crossing climbs about 40 m.
  const pieces = Array.from({ length: 20 }, (_, j) => ({ id: j + 1, tags: { highway: 'path' }, nodes: [j + 1, j + 2], coords: [P(0, 2000 - j * 200), P(0, 1800 - j * 200)] }));
  const n = buildNetwork(pieces, [AREA]);
  addHeights(n, ridge);
  // With 25 m allowed, the most is one side: from the ridge top south, 2 km.
  const strict = findDescents(n, all, wish(3000));
  assert.equal(strict.found.length, 0);
  assert.ok(Math.abs(strict.longest - 2000) < 1, String(strict.longest));
  // With 80 m, the whole 4 km, over the ridge.
  const loose = findDescents(n, all, wish(3000, { maxClimb: 80 }));
  assert.ok(Math.abs(loose.longest - 4000) < 1, String(loose.longest));
  assert.ok(loose.found.length > 0);
  for (const d of loose.found) {
    let low = Infinity;
    for (const [x, y] of lineOf(n, d.steps)) {
      const h = ridge(x, y);
      assert.ok(h - low <= 80 + 1, `${h - low}`);
      low = Math.min(low, h);
    }
  }
});

test('roads not chosen for the route may join trails in a descent, but not make one up', () => {
  // A road across the middle row, and the route only allowed on trails.
  const n = net(slope, 10);
  const use = (d: number) => (n.edges[d >> 1]!.kind === 'road' ? 'connector' as const : 'ok' as const);
  const { found } = findDescents(n, use, wish(3000));
  assert.ok(found.length > 0);
  for (const d of found) {
    const kinds = d.steps.map((s) => n.edges[s.edge]!.kind);
    assert.notEqual(kinds[0], 'road');
    assert.notEqual(kinds.at(-1), 'road');
    // A run of road is 500 m at most.
    let run = 0;
    for (const s of d.steps) {
      run = n.edges[s.edge]!.kind === 'road' ? run + n.edges[s.edge]!.len : 0;
      assert.ok(run <= 500);
    }
  }
  // With no road allowed at all, the middle row can't be crossed... but straight down needs no road, so descents remain.
  assert.ok(findDescents(n, (d) => (n.edges[d >> 1]!.kind === 'road' ? 'no' : 'ok'), wish(3000)).found.length > 0);
});

const req = (more: Partial<PlanRequest> = {}): PlanRequest => ({
  start: P(0, 0), finish: null, distance: 12_000, climb: null, newTrail: 'some', kinds: ['trail', 'track', 'cycleway', 'road'], allowRestricted: false,
  descent: wish(3000), ...more,
});

test('routes asked for a long descent ride one, from its top to its bottom', () => {
  const n = net(slope);
  const routes = new Planner(n, req()).plan();
  assert.ok(routes.length >= 2);
  for (const p of routes) {
    assert.ok(p.descent, 'has a descent');
    assert.ok(p.descent.length >= 3000);
    const part = p.line.slice(p.descent.from, p.descent.to + 1);
    const h = part.map(([x, y]) => slope(x, y));
    assert.ok(h[0]! - h.at(-1)! >= 0.03 * p.descent.length - 1, 'drops as much as asked');
    for (let i = 1; i < h.length; i++) assert.ok(h[i]! <= h[i - 1]! + 1e-6, 'never climbs on the descent');
    // A loop: back where it started.
    assert.deepEqual(p.line[0], p.line.at(-1));
    // The route's summary says where the descent is, in metres along it.
    const r = describeRoute(p, slope, true, 'x');
    assert.ok(r.descent && r.descent.to - r.descent.from > 2900 && r.descent.to <= r.stats.distance + 1, JSON.stringify(r.descent));
    assert.ok(Math.abs(r.descent.drop - p.descent.drop) < 1);
  }
  // The same every time.
  assert.deepEqual(new Planner(n, req()).plan().map((p) => p.steps), routes.map((p) => p.steps));
  assert.equal(elevated(routes[0]!.line, slope).length > routes[0]!.line.length, true);
});

test('when no descent is long enough, planning says why and how long the longest is', () => {
  const n = net(slope);
  assert.throws(() => new Planner(n, req({ descent: wish(9000) })).plan(), /No descent here is 9\.0 km long\. The longest is [4-6]\.\d km/);
  assert.throws(() => new Planner(n, req({ descent: wish(3000, { minGrade: 8 }) })).plan(), /longest is|No descent was found/);
  // Flat ground has no descent at all.
  const flat = net(() => 500);
  assert.throws(() => new Planner(flat, req()).plan(), /No descent was found here/);
  // Unknown elevation is never taken for a descent.
  const unknown = net(() => NaN);
  assert.throws(() => new Planner(unknown, req()).plan(), /No descent was found here/);
});
