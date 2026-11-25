import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { areasText, newAreaId, parseAreas, type Area } from '../src/core/areas.ts';
import { parseConfig } from '../src/core/config.ts';
import { M_PER_DEG } from '../src/core/track.ts';
import { tilesFor } from '../src/core/roads.ts';
import { drawnShape, MAX_SIDE, rectFrom, rectSize, shapeProblem, unionEdge, type Shape } from '../src/core/shapes.ts';
import { Areas } from '../src/core/areadata.ts';
import { OsmStore } from '../src/desktop/osm.ts';

const C: [number, number] = [-0.47, 39.7];
const K = M_PER_DEG * Math.cos((C[1] * Math.PI) / 180);
/** A point x metres east and y metres north of C. */
const P = (x: number, y = 0): [number, number] => [C[0] + x / K, C[1] + y / M_PER_DEG];
const circle = (center: [number, number], radius: number): Shape => ({ kind: 'circle', center, radius });
const area = (id: string, center: [number, number], radius: number, more: Partial<Area> = {}): Area => ({ id, name: null, shape: circle(center, radius), on: true, hide: [], group: null, ...more });

// --- areas.json -----------------------------------------------------------------

test('areas.json is read, with optional fields and problems reported', () => {
  const { areas, problems } = parseAreas(JSON.stringify({
    '//': 'note',
    areas: [
      { id: 'home', name: ' Calderona ', center: [-0.47, 39.7], radius: 1500, on: false, hide: ['road'] },
      { center: [-0.5, 39.6], radius: 800 },
      { center: [-0.5, 39.6], radius: 20 },
      { id: 'home', center: [1, 1], radius: 100 },
      { id: 'x', center: [1, 1], radius: 100, hide: ['boats'] },
    ],
  }));
  assert.equal(areas.length, 3);
  assert.deepEqual(areas[0], { id: 'home', name: 'Calderona', shape: circle([-0.47, 39.7], 1500), on: false, hide: ['road'], group: null });
  assert.equal(areas[1]!.on, true);
  assert.match(areas[1]!.id, /^[a-z0-9-]+$/);
  assert.equal(parseAreas(JSON.stringify({ areas: [{ center: [-0.5, 39.6], radius: 800 }] })).areas[0]!.id, areas[1]!.id, 'the same id each read');
  assert.deepEqual(areas[2]!.hide, []);
  assert.equal(problems.length, 3);
  assert.match(problems.join(' '), /radius/);
  assert.match(problems.join(' '), /another area or group has the id "home"/);
  assert.match(problems.join(' '), /"hide"/);
});

test('areas.json is written one area per line, keeping comments, and reads back the same', () => {
  const list = [area('a1', [-0.4701234567, 39.7], 1500.4, { name: 'Ridge' }), area('b2', [1, 2], 300, { on: false, hide: ['road', 'track'] })];
  const text = areasText(list, [], JSON.stringify({ '//': 'mine', areas: [] }));
  assert.match(text, /"\/\/": "mine"/);
  assert.equal(text.split('\n').filter((l) => l.includes('"center"')).length, 2);
  const back = parseAreas(text);
  assert.deepEqual(back.problems, []);
  assert.deepEqual(back.areas, [{ ...list[0]!, shape: circle([-0.470123, 39.7], 1500) }, list[1]]);
  assert.deepEqual(parseAreas(areasText([])).areas, []);
  // It is part of the config.
  assert.equal(parseConfig({ 'areas.json': text }).config.areas.length, 2);
});

test('groups are read and written with their circles, and empty or unknown ones are dropped', () => {
  const { areas, groups, problems } = parseAreas(JSON.stringify({
    groups: [{ id: 'g-hills', name: ' Hills ', joined: true }, { id: 'g-hills', name: 'Again' }, { id: 'Bad Id' }, { id: 'g-two', joined: 'yes' }],
    areas: [
      { id: 'a', center: [1, 1], radius: 100, group: 'g-hills' },
      { id: 'b', center: [1.001, 1], radius: 100, group: 'g-hills' },
      { id: 'c', center: [2, 2], radius: 100, group: 'g-none' },
      { id: 'g-two', center: [3, 3], radius: 100 },
    ],
  }));
  assert.deepEqual(groups, [{ id: 'g-hills', name: 'Hills', joined: true }, { id: 'g-two', name: 'Group', joined: false }]);
  assert.deepEqual(areas.map((a) => a.group), ['g-hills', 'g-hills', null]);
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.match(problems.join(' '), /another group has the id "g-hills"/);
  assert.match(problems.join(' '), /"joined" should be true or false/);
  assert.match(problems.join(' '), /"group" should be the id/);
  assert.match(problems.join(' '), /another area or group has the id "g-two"/);

  // Written back, the group with no circles is gone, and the rest reads the same.
  const text = areasText(areas, groups);
  assert.equal(text.split('\n').filter((l) => l.includes('"joined"')).length, 1);
  const back = parseAreas(text);
  assert.deepEqual(back.problems, []);
  assert.deepEqual(back.groups, [groups[0]]);
  assert.deepEqual(back.areas, areas);
  assert.deepEqual(parseConfig({ 'areas.json': text }).config.groups, [groups[0]]);
  // No groups, no "groups" key.
  assert.doesNotMatch(areasText([area('x', C, 100)]), /groups/);
  // Group ids can be asked for with a prefix, and never match an area's.
  assert.match(newAreaId([area('x', C, 100)], Math.random, 'g-'), /^g-[a-z0-9]{6}$/);
});

test('the outline around overlapping circles leaves out where they overlap, and meets where they cross', () => {
  const dist = (p: [number, number], c: [number, number]) => Math.hypot((p[0] - c[0]) * K, (p[1] - c[1]) * M_PER_DEG);
  // Apart: each circle is a whole ring.
  const apart = unionEdge([circle(C, 500), circle(P(2000), 500)]);
  assert.equal(apart.length, 2);
  assert.deepEqual(apart[0]![0], apart[0]!.at(-1));
  // Overlapping: one arc each, ending exactly on the other circle.
  const a = { kind: 'circle' as const, center: C, radius: 500 }, b = { kind: 'circle' as const, center: P(600), radius: 500 };
  const both = unionEdge([a, b]);
  assert.equal(both.length, 2);
  for (const [line, other] of [[both[0]!, b], [both[1]!, a]] as const) {
    for (const p of line.slice(1, -1)) assert.ok(dist(p, other.center) >= other.radius - 0.5, 'no part inside the other circle');
    assert.ok(Math.abs(dist(line[0]!, other.center) - other.radius) < 0.5 && Math.abs(dist(line.at(-1)!, other.center) - other.radius) < 0.5, 'ends where the circles cross');
  }
  // A circle inside another adds no edge.
  assert.equal(unionEdge([circle(C, 1000), circle(P(100), 200)]).length, 1);
});

test('rectangles are read and written as a box, and bad ones are reported', () => {
  const box = rectFrom(P(-1000, -500), P(1000, 500));
  if (box.kind !== 'rect') throw new Error('not a rectangle');
  const { areas, problems } = parseAreas(JSON.stringify({
    areas: [
      { id: 'r', name: 'Valley', box: box.box, hide: ['road'] },
      { box: box.box.map((v) => v + 0.1) },
      { id: 'flipped', box: [box.box[2], box.box[1], box.box[0], box.box[3]] },
      { id: 'thin', box: [box.box[0], box.box[1], box.box[2], box.box[1] + 50 / M_PER_DEG] },
      { id: 'huge', box: [-1, 39, 1, 40] },
      { id: 'both', box: box.box, center: C, radius: 500 },
    ],
  }));
  assert.deepEqual(areas.map((a) => a.id).filter((id) => !id.startsWith('r') || id === 'r'), ['r', 'both']);
  assert.deepEqual(areas[0], { id: 'r', name: 'Valley', shape: box, on: true, hide: ['road'], group: null });
  assert.match(areas[1]!.id, /^r[a-z0-9-]+$/);
  assert.ok(areas[1]!.id.length <= 40);
  assert.equal(parseAreas(JSON.stringify({ areas: [{ box: box.box.map((v) => v + 0.1) }] })).areas[0]!.id, areas[1]!.id, 'the same id each read');
  // "box" wins over "center" and "radius".
  assert.equal(areas[2]!.shape.kind, 'rect');
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems.join(' '), /"box" should be \[west, south, east, north\]/);
  assert.match(problems.join(' '), /"box" sides should be 100 to 20000 metres/);

  // Written back, circles and rectangles read the same, rounded.
  const text = areasText([...areas, area('c', C, 500)]);
  assert.equal(text.split('\n').filter((l) => l.includes('"box"')).length, 3);
  assert.equal(text.split('\n').filter((l) => l.includes('"center"')).length, 1);
  const back = parseAreas(text);
  assert.deepEqual(back.problems, []);
  assert.equal(back.areas.length, 4);
  for (const [i, a] of back.areas.slice(0, 3).entries()) {
    const was = areas[i]!.shape, now = a.shape;
    assert.ok(was.kind === 'rect' && now.kind === 'rect' && now.box.every((v, j) => Math.abs(v - was.box[j]!) < 1e-6));
  }
});

test('two clicks make a circle or a rectangle, no bigger than an area can be', () => {
  const c = drawnShape('circle', C, P(300, 400));
  assert.ok(c.kind === 'circle' && Math.abs(c.radius - 500) < 0.5);
  const far = drawnShape('circle', C, P(50_000));
  assert.ok(far.kind === 'circle' && far.radius === 10_000);
  // Corners in any order give the same box.
  assert.deepEqual(drawnShape('rect', P(500, 300), P(-500, -300)), drawnShape('rect', P(-500, -300), P(500, 300)));
  const r = drawnShape('rect', P(-500, -300), P(500, 300));
  assert.ok(r.kind === 'rect');
  const [w, h] = rectSize(r.box);
  assert.ok(Math.abs(w - 1000) < 1 && Math.abs(h - 600) < 1, `${w} × ${h}`);
  assert.equal(shapeProblem(r), null);
  // Dragged too far, each side stops just short of the limit, measured as the file checks it.
  for (const to of [P(90_000, 5_000), P(5_000, -90_000), P(-90_000, 90_000)]) {
    const big = drawnShape('rect', C, to);
    assert.ok(big.kind === 'rect');
    assert.ok(Math.max(...rectSize(big.box)) <= MAX_SIDE, String(rectSize(big.box)));
    assert.equal(shapeProblem(big), null);
  }
  assert.match(shapeProblem(drawnShape('rect', C, P(50, 500)))!, /rectangle's sides/);
  assert.match(shapeProblem(drawnShape('circle', C, P(20)))!, /circle's radius/);
});

test('the outline around a circle and rectangles leaves out where they overlap', () => {
  const box = rectFrom(P(0, -300), P(1000, 300));
  if (box.kind !== 'rect') throw new Error('not a rectangle');
  const inBox = (p: [number, number]) => p[0] > box.box[0] + 1e-9 && p[0] < box.box[2] - 1e-9 && p[1] > box.box[1] + 1e-9 && p[1] < box.box[3] - 1e-9;
  const round = circle(C, 500);
  const edge = unionEdge([round, box]);
  assert.equal(edge.length, 2, 'an arc of the circle and the rest of the box');
  const dist = (p: [number, number]) => Math.hypot((p[0] - C[0]) * K, (p[1] - C[1]) * M_PER_DEG);
  for (const p of edge[0]!) assert.ok(!inBox(p), 'no part of the arc inside the box');
  for (const p of edge[1]!.slice(1, -1)) assert.ok(dist(p) >= 499.5, 'no part of the box inside the circle');
  // The box's outline keeps its far corners exactly.
  const corners = edge[1]!.filter((p) => (p[0] === box.box[0] || p[0] === box.box[2]) && (p[1] === box.box[1] || p[1] === box.box[3]));
  assert.equal(corners.length, 2);
  // Ends meet on the circle.
  for (const p of [edge[1]![0]!, edge[1]!.at(-1)!]) assert.ok(Math.abs(dist(p) - 500) < 0.5);
  // A lone rectangle is its closed ring of corners; one inside another adds nothing.
  assert.equal(unionEdge([box])[0]!.length, 5);
  assert.equal(unionEdge([box, rectFrom(P(100, -100), P(200, 100))]).length, 1);
});

test('new area ids are short and unused', () => {
  let n = 0;
  const seq = [0.5, 0.5, 0.25];
  const id = newAreaId([area(Math.floor(0.5 * 36 ** 6).toString(36).padStart(6, '0'), C, 100)], () => seq[n++]!);
  assert.equal(id, Math.floor(0.25 * 36 ** 6).toString(36).padStart(6, '0'));
});

// --- shared store and downloads --------------------------------------------------

/** A fake OpenStreetMap: a long east-west trail and a north-south track crossing it, plus a short path far east. */
const WORLD = [
  { id: 1, tags: { highway: 'path', name: 'Ridge trail' }, pts: [P(-3000), P(-1000), P(0), P(1000), P(3000)], nodes: [101, 102, 103, 104, 105] },
  { id: 2, tags: { highway: 'track' }, pts: [P(0, -2000), P(0), P(0, 2000)], nodes: [201, 103, 203] },
  { id: 3, tags: { highway: 'path', name: 'Far path' }, pts: [P(8000), P(8200)], nodes: [301, 302] },
];
/** Answers a query with the ways that cross any of its boxes, like Overpass. */
function fakeOverpass(log: string[]) {
  return async (q: string) => {
    log.push(q);
    const boxes = [...q.matchAll(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/g)].map((m) => m.slice(1).map(Number) as [number, number, number, number]);
    const hit = (pts: [number, number][]) => boxes.some(([s, w, n, e]) => pts.some(([x, y]) => x >= w && x <= e && y >= s && y <= n));
    return {
      elements: WORLD.filter((wy) => hit(wy.pts)).map((wy) => ({
        type: 'way', id: wy.id, tags: wy.tags, nodes: wy.nodes, geometry: wy.pts.map(([lon, lat]) => ({ lon, lat })),
      })),
    };
  };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await settle();
  assert.ok(ok(), 'timed out');
}

test('the store keeps one copy of each way and node, finds them by circle, and prunes what no area needs', () => {
  const store = new OsmStore(join(mkdtempSync(join(tmpdir(), 'te-osm-')), 'osm.db'));
  const ways = WORLD.map((w) => ({ id: w.id, tags: w.tags, nodes: w.nodes, coords: w.pts }));
  const tiles = tilesFor(circle(C, 500));
  store.save(ways, tiles);
  store.save(ways.slice(0, 2), tiles); // the same again changes nothing
  assert.deepEqual(store.counts(), { ways: 3, nodes: 9, tiles: tiles.length });
  const near = store.waysIn(circle(C, 500));
  assert.deepEqual(near.map((w) => w.id).sort(), [1, 2]);
  assert.deepEqual(near.find((w) => w.id === 2)!.coords[1], P(0));
  // Shared node 103 is one row.
  assert.equal(store.counts().nodes, 9);
  // Keep only the tiles around the middle: the far path goes, with its nodes.
  assert.equal(store.prune(new Set(tilesFor(circle(C, 200)))), 1);
  assert.deepEqual(store.counts().ways, 2);
  assert.equal(store.counts().nodes, 7);
  store.prune(new Set());
  assert.deepEqual(store.counts(), { ways: 0, nodes: 0, tiles: 0 });
  store.close();
});

test('areas download in parts, share tiles, and are ready without downloading again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-areas-'));
  const store = new OsmStore(join(dir, 'osm.db'));
  const log: string[] = [];
  let changes = 0;
  const saved: number[] = [];
  const save = store.save.bind(store);
  store.save = (ways, tiles) => {
    saved.push(...tiles);
    save(ways, tiles);
  };
  const areas = new Areas(store, fakeOverpass(log), () => changes++);
  areas.set([area('big', C, 2500)]);
  assert.equal(areas.view()[0]!.state, 'downloading');
  await until(() => areas.view()[0]!.state === 'ready');
  const parts = log.length;
  assert.ok(parts > 1, 'a big area is fetched in several parts');
  const v = areas.view()[0]!;
  assert.equal(v.done, v.total);
  assert.ok(Math.abs(v.totals.trail! - 5000) < 5 && Math.abs(v.totals.track! - 4000) < 5, JSON.stringify(v.totals));
  const roads = areas.roadsOf('big')!.roads;
  assert.deepEqual(roads.map((r) => r.name), ['Ridge trail', null]);

  // A smaller circle inside it needs nothing new.
  areas.set([area('big', C, 2500), area('small', P(500), 800)]);
  assert.equal(areas.view()[1]!.state, 'ready');
  assert.equal(log.length, parts);
  // A joined group counts roads in its circles once, however much they overlap.
  areas.set([area('big', C, 2500), area('small', P(500), 800, { group: 'g-x' }), area('small2', P(-500), 800, { group: 'g-x' })], [{ id: 'g-x', name: 'X', joined: true }]);
  const [g] = areas.groupView();
  assert.equal(g!.state, 'ready');
  assert.deepEqual(g!.members, ['small', 'small2']);
  // Two 800 m circles 1000 m apart along the trail: 2600 m of it, not 3200.
  assert.ok(Math.abs(g!.totals.trail! - 2600) < 5, JSON.stringify(g!.totals));
  assert.ok(areas.roadsOf('g-x')!.roads.length > 0);
  // A circle and a rectangle can be joined: a 1600 m box along the trail from 0 to 1600, and the 800 m circle at -500.
  const strip: Area = { id: 'strip', name: null, shape: rectFrom(P(0, -100), P(1600, 100)), on: true, hide: [], group: 'g-x' };
  areas.set([area('big', C, 2500), area('small2', P(-500), 800, { group: 'g-x' }), strip], [{ id: 'g-x', name: 'X', joined: true }]);
  const [mixed] = areas.groupView();
  assert.equal(mixed!.state, 'ready');
  // The circle covers -1300 to 300 of the trail, the box 0 to 1600: 2900 m, the overlap once.
  assert.ok(Math.abs(mixed!.totals.trail! - 2900) < 5, JSON.stringify(mixed!.totals));
  // The track, along the box's west side, is counted once where it is in both: the circle's chord.
  assert.ok(Math.abs(mixed!.totals.track! - 2 * Math.sqrt(800 ** 2 - 500 ** 2)) < 5, JSON.stringify(mixed!.totals));
  // Separate, it has no roads of its own.
  areas.set([area('big', C, 2500), area('small', P(500), 800, { group: 'g-x' })], [{ id: 'g-x', name: 'X', joined: false }]);
  assert.deepEqual(areas.groupView()[0]!.totals, {});
  assert.equal(areas.roadsOf('g-x'), null);

  // A bigger one downloads only the ring around it.
  areas.set([area('big', C, 2500), area('small', P(500), 800), area('bigger', C, 3500)]);
  await until(() => areas.view()[2]!.state === 'ready');
  const first = new Set(tilesFor(circle(C, 2500)));
  const ring = tilesFor(circle(C, 3500)).filter((k) => !first.has(k));
  assert.equal(saved.length, first.size + ring.length, 'every tile downloaded exactly once');
  assert.equal(new Set(saved).size, saved.length);

  // Removing the big ones keeps what the small one uses.
  areas.set([area('small', P(500), 800)]);
  areas.prune();
  assert.equal(areas.view()[0]!.state, 'ready');
  assert.deepEqual(areas.roadsOf('small')!.roads.map((r) => r.name), ['Ridge trail', null]);
  assert.ok(store.counts().tiles === tilesFor(circle(P(500), 800)).length);
  assert.ok(changes > 0);
  areas.stop();
  store.close();

  // Everything is still there after a restart.
  const again = new OsmStore(join(dir, 'osm.db'));
  const a2 = new Areas(again, async () => assert.fail('should not download'), () => {});
  a2.set([area('small', P(500), 800)]);
  assert.equal(a2.view()[0]!.state, 'ready');
  again.close();
});

test('a failed download is reported, and Try again resumes it', async () => {
  const store = new OsmStore(join(mkdtempSync(join(tmpdir(), 'te-areas-')), 'osm.db'));
  let fail = true;
  const real = fakeOverpass([]);
  const areas = new Areas(store, async (q) => {
    if (fail) throw new Error('overpass-api.de is busy.');
    return real(q);
  }, () => {});
  areas.set([area('a', C, 300)]);
  await until(() => areas.view()[0]!.state === 'error');
  assert.equal(areas.view()[0]!.error, 'overpass-api.de is busy.');
  fail = false;
  areas.retry('a');
  await until(() => areas.view()[0]!.state === 'ready');
  assert.equal(areas.view()[0]!.error, null);
  areas.stop();
  store.close();
});
