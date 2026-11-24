import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { areasText, newAreaId, parseAreas, type Area } from '../src/core/areas.ts';
import { parseConfig } from '../src/core/config.ts';
import { M_PER_DEG } from '../src/core/track.ts';
import { tilesFor } from '../src/core/roads.ts';
import { Areas } from '../src/desktop/areas.ts';
import { OsmStore } from '../src/desktop/osm.ts';

const C: [number, number] = [-0.47, 39.7];
const K = M_PER_DEG * Math.cos((C[1] * Math.PI) / 180);
/** A point x metres east and y metres north of C. */
const P = (x: number, y = 0): [number, number] => [C[0] + x / K, C[1] + y / M_PER_DEG];
const area = (id: string, center: [number, number], radius: number, more: Partial<Area> = {}): Area => ({ id, name: null, center, radius, on: true, hide: [], ...more });

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
  assert.deepEqual(areas[0], { id: 'home', name: 'Calderona', center: [-0.47, 39.7], radius: 1500, on: false, hide: ['road'] });
  assert.equal(areas[1]!.on, true);
  assert.match(areas[1]!.id, /^[a-z0-9-]+$/);
  assert.equal(parseAreas(JSON.stringify({ areas: [{ center: [-0.5, 39.6], radius: 800 }] })).areas[0]!.id, areas[1]!.id, 'the same id each read');
  assert.deepEqual(areas[2]!.hide, []);
  assert.equal(problems.length, 3);
  assert.match(problems.join(' '), /radius/);
  assert.match(problems.join(' '), /another area has the id "home"/);
  assert.match(problems.join(' '), /"hide"/);
});

test('areas.json is written one area per line, keeping comments, and reads back the same', () => {
  const list = [area('a1', [-0.4701234567, 39.7], 1500.4, { name: 'Ridge' }), area('b2', [1, 2], 300, { on: false, hide: ['road', 'track'] })];
  const text = areasText(list, JSON.stringify({ '//': 'mine', areas: [] }));
  assert.match(text, /"\/\/": "mine"/);
  assert.equal(text.split('\n').filter((l) => l.includes('"center"')).length, 2);
  const back = parseAreas(text);
  assert.deepEqual(back.problems, []);
  assert.deepEqual(back.areas, [{ ...list[0]!, center: [-0.470123, 39.7], radius: 1500 }, list[1]]);
  assert.deepEqual(parseAreas(areasText([])).areas, []);
  // It is part of the config.
  assert.equal(parseConfig({ 'areas.json': text }).config.areas.length, 2);
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
  const tiles = tilesFor(C, 500);
  store.save(ways, tiles);
  store.save(ways.slice(0, 2), tiles); // the same again changes nothing
  assert.deepEqual(store.counts(), { ways: 3, nodes: 9, tiles: tiles.length });
  const near = store.waysIn(C, 500);
  assert.deepEqual(near.map((w) => w.id).sort(), [1, 2]);
  assert.deepEqual(near.find((w) => w.id === 2)!.coords[1], P(0));
  // Shared node 103 is one row.
  assert.equal(store.counts().nodes, 9);
  // Keep only the tiles around the middle: the far path goes, with its nodes.
  assert.equal(store.prune(new Set(tilesFor(C, 200))), 1);
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
  // A bigger one downloads only the ring around it.
  areas.set([area('big', C, 2500), area('small', P(500), 800), area('bigger', C, 3500)]);
  await until(() => areas.view()[2]!.state === 'ready');
  const first = new Set(tilesFor(C, 2500));
  const ring = tilesFor(C, 3500).filter((k) => !first.has(k));
  assert.equal(saved.length, first.size + ring.length, 'every tile downloaded exactly once');
  assert.equal(new Set(saved).size, saved.length);

  // Removing the big ones keeps what the small one uses.
  areas.set([area('small', P(500), 800)]);
  areas.prune();
  assert.equal(areas.view()[0]!.state, 'ready');
  assert.deepEqual(areas.roadsOf('small')!.roads.map((r) => r.name), ['Ridge trail', null]);
  assert.ok(store.counts().tiles === tilesFor(P(500), 800).length);
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
