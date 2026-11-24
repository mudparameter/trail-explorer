import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNetwork, coverage, RideIndex, type Circle } from '../src/core/network.ts';
import { Planner, type PlanRequest } from '../src/core/planner.ts';
import { describe, elevated, gpxLine, km, height, rate, routeGpx, statsOfLine } from '../src/core/route.ts';
import type { OsmWay } from '../src/core/roads.ts';
import { metres, M_PER_DEG } from '../src/core/track.ts';

const C: [number, number] = [-0.47, 39.7];
const K = M_PER_DEG * Math.cos((C[1] * Math.PI) / 180);
const P = (x: number, y: number): [number, number] => [C[0] + x / K, C[1] + y / M_PER_DEG];

/** A grid of trails 200 m apart, 4 km across, with a road along the middle row. Node ids are shared where lines cross. */
function grid(n = 21, gap = 200): OsmWay[] {
  const id = (i: number, j: number) => i * 1000 + j + 1;
  const ways: OsmWay[] = [];
  const half = ((n - 1) * gap) / 2;
  for (let j = 0; j < n; j++) {
    const nodes = Array.from({ length: n }, (_, i) => id(i, j));
    ways.push({ id: 10_000 + j, tags: { highway: j === 10 ? 'tertiary' : 'path', name: `Row ${j}` }, nodes, coords: nodes.map((_, i) => P(i * gap - half, j * gap - half)) });
  }
  for (let i = 0; i < n; i++) {
    const nodes = Array.from({ length: n }, (_, j) => id(i, j));
    ways.push({ id: 20_000 + i, tags: { highway: i === 3 ? 'track' : 'path', ...(i === 15 ? { access: 'private' } : {}) }, nodes, coords: nodes.map((_, j) => P(i * gap - half, j * gap - half)) });
  }
  return ways;
}
const circle: Circle = { center: C, radius: 1900 };
/** Rides along the western half of every row. */
const rides = Array.from({ length: 21 }, (_, j) => Float64Array.from([P(-2000, j * 200 - 2000), P(0, j * 200 - 2000)].flat()));
const req = (more: Partial<PlanRequest> = {}): PlanRequest => ({ start: P(-30, 20), finish: null, distance: 8000, climb: null, newTrail: 'some', kinds: ['trail', 'track', 'cycleway', 'road'], allowRestricted: false, ...more });

test('the network splits ways at junctions, keeps only what is inside the areas, and knows what is ridden', () => {
  const idx = new RideIndex(rides, [-1, 38, 1, 41]);
  const net = buildNetwork(grid(), [circle], idx.ridden);
  assert.ok(net.edges.length > 500);
  assert.ok(net.edges.every((e) => e.len > 0 && e.len <= 201));
  const { total, ridden } = coverage(net);
  assert.ok(ridden / total > 0.15 && ridden / total < 0.4, `${ridden / total}`);
  // Crossing a ride doesn't make a north-south trail ridden.
  const ns = net.edges.filter((e) => e.coords[0] === e.coords[e.coords.length - 2]);
  assert.ok(ns.every((e) => e.ridden < 0.5));
  assert.ok(net.edges.some((e) => e.restricted));
});

test('loops come back to the start near the distance, differ from each other, mix in new trail, and are the same every time', () => {
  const net = buildNetwork(grid(), [circle], new RideIndex(rides, [-1, 38, 1, 41]).ridden);
  const routes = new Planner(net, req()).plan(5);
  assert.ok(routes.length >= 3 && routes.length <= 5);
  for (const r of routes) {
    assert.ok(Math.abs(r.distance - 8000) / 8000 < 0.2, `${r.distance}`);
    assert.deepEqual(r.line[0], r.line[r.line.length - 1], 'a loop ends where it starts');
    assert.ok(!r.restricted, 'private trails left out');
    assert.ok(r.fresh > 0);
  }
  const again = new Planner(net, req()).plan(5);
  assert.deepEqual(again.map((r) => r.line), routes.map((r) => r.line));
  // Restricted trails can be allowed.
  const any = new Planner(net, req({ allowRestricted: true, start: P(1000, 0) })).plan(5);
  assert.ok(any.some((r) => r.restricted));
});

test('how much new trail is wished for changes the routes, in that order', () => {
  const net = buildNetwork(grid(), [circle], new RideIndex(rides, [-1, 38, 1, 41]).ridden);
  // Start where ridden and new trails meet.
  const share = (newTrail: 'little' | 'some' | 'lots') => {
    const rs = new Planner(net, req({ newTrail, start: P(0, 0) })).plan(5);
    return rs.reduce((n, r) => n + r.fresh / r.distance, 0) / rs.length;
  };
  const [little, some, lots] = [share('little'), share('some'), share('lots')];
  // Every loop here is at least half new (north-south paths are never ridden), so a little and some are alike.
  assert.ok(little <= some + 0.02 && some < lots && lots - little > 0.1, `${little} ${some} ${lots}`);
});

test('a route between two points, and only on the kinds of path chosen', () => {
  const net = buildNetwork(grid(), [circle], new RideIndex(rides, [-1, 38, 1, 41]).ridden);
  const routes = new Planner(net, req({ start: P(-1000, -1000), finish: P(1000, 1000), distance: 6000, kinds: ['trail', 'track'] })).plan(5);
  assert.ok(routes.length >= 3);
  for (const r of routes) {
    assert.ok(!r.kinds.road, 'no roads');
    const end = r.line[r.line.length - 1]!;
    assert.ok(metres(end[0], end[1], ...P(1000, 1000)) < 150, 'ends at the finish');
  }
  assert.throws(() => new Planner(net, req({ kinds: [] })), /no paths/);
});

test('elevation, steep parts, rating, units and GPX', () => {
  // 1 km flat, 200 m climbing at 20%, 1 km flat, 200 m down at 25%.
  const line: [number, number][] = [];
  for (let x = 0; x <= 2600; x += 20) line.push(P(x, 0));
  const ele = (lon: number) => {
    const x = (lon - C[0]) * K;
    return x < 1000 ? 100 : x < 1200 ? 100 + (x - 1000) * 0.2 : x < 2200 ? 140 : Math.max(90, 140 - (x - 2200) * 0.25);
  };
  const s = statsOfLine(elevated(line, ele));
  assert.ok(Math.abs(s.distance - 2600) < 2);
  assert.ok(Math.abs(s.gain - 40) <= 3 && Math.abs(s.loss - 50) <= 3, `${s.gain} ${s.loss}`);
  assert.ok(s.maxUp > 17 && s.maxUp <= 20.5 && s.maxDown > 21 && s.maxDown <= 25.5, `${s.maxUp} ${s.maxDown}`);
  assert.equal(s.steepUp.length, 1);
  assert.equal(s.steepDown.length, 1);
  assert.ok(s.profile.length <= 401);
  const r = rate(s, { trail: 2400 }, 3);
  assert.ok(r.level >= 2, JSON.stringify(r));
  assert.equal(rate({ ...s, gain: 10, maxUp: 3, maxDown: 3 }, { road: 2400 }, null).difficulty, 'Easy');
  assert.equal(km(24300), '24.3 km (15.1 mi)');
  assert.equal(height(540), '540 m (1,772 ft)');
  const route = describe({ steps: [], line, distance: 2400, fresh: 2000, repeated: 0, kinds: { trail: 2400 }, level: null, restricted: false, heading: 'east' }, ele, false, 'x');
  assert.match(route.name, /^East route, 2.6 km$/);
  const gpx = routeGpx('A & B <ride>', route.line, '2026-11-24T00:00:00Z');
  assert.match(gpx, /A &amp; B &lt;ride&gt;/);
  const back = gpxLine(gpx);
  assert.equal(back.length, route.line.length);
  assert.ok(back.length > (2600 / 10) * 0.9, 'a point about every 10 m');
  // The same stats from the saved file as when planned.
  assert.deepEqual(statsOfLine(back), route.stats);
});

test('terrain tiles: which ones, PNG decoding and elevation between pixels', async () => {
  const { crc32, deflateSync } = await import('node:zlib');
  const { decodeTerrarium, Elevation, terrainTiles, TERRAIN_ZOOM } = await import('../src/core/terrain.ts');
  // A tile whose elevation rises 1 m per pixel to the east, from 100 m.
  const raw = Buffer.alloc((256 * 3 + 1) * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const v = 100 + x + 32768;
    raw.set([Math.floor(v / 256), v % 256, 0], y * (256 * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const t = decodeTerrarium(png);
  assert.equal(t[0], 100);
  assert.equal(t[255 * 256 + 255], 355);
  assert.throws(() => decodeTerrarium(Buffer.from('nope')), /Not a PNG/);
  const n = 2 ** TERRAIN_ZOOM;
  const [tx, ty] = [Math.floor(((C[0] + 180) / 360) * n), 6000];
  const ele = new Elevation((x, y) => (x === tx && y === ty ? t : null));
  const lonAt = (px: number) => ((tx + px / 256) / n) * 360 - 180;
  const latAt = (py: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / 256)) / n))) * 180) / Math.PI;
  assert.ok(Math.abs(ele.at(lonAt(100.5), latAt(50.5)) - 200) < 0.01);
  assert.ok(Math.abs(ele.at(lonAt(101), latAt(50.5)) - 200.5) < 0.01, 'between pixels');
  assert.ok(Number.isNaN(ele.at(lonAt(-300), latAt(50))), 'no tile');
  const tiles = terrainTiles([C[0] - 0.01, C[1] - 0.01, C[0] + 0.01, C[1] + 0.01]);
  assert.ok(tiles.length >= 4 && tiles.length <= 9);
  assert.throws(() => terrainTiles([-10, 30, 10, 50]), /more than/);
});

test('saved routes are read and written one per line, and odd entries are left out', async () => {
  const { parseRoutes, routesText, newRouteId } = await import('../src/core/routes.ts');
  const r = { id: 'abc123', name: 'Ridge', created: '2026-11-24T10:00:00.000Z', loop: true, start: [-0.47, 39.7] as [number, number], distance: 12000, gain: 300, loss: 300, maxUp: 12, maxDown: 18, difficulty: 'Moderate' as const, fresh: 4000 };
  const text = routesText([r, { ...r, id: 'def456', name: '  ' }]);
  assert.equal(text.split('\n').filter((l) => l.includes('"id"')).length, 2);
  const back = parseRoutes(text);
  assert.deepEqual(back[0], r);
  assert.equal(back[1]!.name, 'Route');
  assert.deepEqual(parseRoutes(JSON.stringify({ routes: [{ id: 'BAD!' }, { id: 'x1y2', start: [1, 2] }, r, r] })), [r]);
  assert.deepEqual(parseRoutes('not json'), []);
  assert.match(routesText([], JSON.stringify({ '//': 'mine' })), /"\/\/": "mine"/);
  assert.match(newRouteId(new Set()), /^[a-z0-9]{8}$/);
});
