import assert from 'node:assert/strict';
import test from 'node:test';
import { clipToCircle, distance, overpassQuery, readOverpass, roadsGeoJson } from '../src/core/roads.ts';
import { M_PER_DEG } from '../src/core/track.ts';

const C: [number, number] = [0, 0];
/** A point `x` metres east and `y` metres north of the centre, on the equator. */
const P = (x: number, y = 0): [number, number] => [x / M_PER_DEG, y / M_PER_DEG];
const way = (highway: string, pts: [number, number][], tags: Record<string, string> = {}) => ({
  type: 'way', tags: { highway, ...tags }, geometry: pts.map(([lon, lat]) => ({ lon, lat })),
});
const near = (a: number, b: number, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);

test('a line through the centre is cut at the edge on both sides', () => {
  const r = clipToCircle([P(-500), P(500)], C, 200);
  assert.equal(r.lines.length, 1);
  near(r.length, 400);
  near(r.lines[0]![0]![0] * M_PER_DEG, -200);
  near(r.lines[0]!.at(-1)![0] * M_PER_DEG, 200);
});

test('a line that leaves and comes back is split in two', () => {
  const r = clipToCircle([P(-150), P(-150, 300), P(150, 300), P(150)], C, 200);
  assert.equal(r.lines.length, 2);
  // Each side runs from y=0 up to where x=±150 meets the circle: sqrt(200² - 150²).
  near(r.length, 2 * Math.sqrt(200 ** 2 - 150 ** 2));
});

test('lines wholly inside are kept as they are, and those outside are dropped', () => {
  const inside = clipToCircle([P(-50), P(0, 50), P(50)], C, 200);
  assert.equal(inside.lines[0]!.length, 3);
  near(inside.length, 2 * Math.hypot(50, 50));
  assert.equal(clipToCircle([P(300), P(400, 100)], C, 200).lines.length, 0);
  // Passes by without touching.
  assert.equal(clipToCircle([P(-500, 250), P(500, 250)], C, 200).lines.length, 0);
});

test('ways are grouped by name and kind, longest first, unnamed last', () => {
  const roads = readOverpass({
    elements: [
      way('path', [P(-100, 10), P(0, 10)], { name: 'Ridge trail', surface: 'dirt', 'mtb:scale': '2' }),
      way('path', [P(0, 10), P(100, 10)], { name: 'Ridge trail', surface: 'rock', 'mtb:scale': '2' }),
      way('path', [P(-100, 10), P(-100, 20)], { surface: 'dirt' }),
      way('footway', [P(0, -100), P(0, 100)], { name: 'Short walk', bicycle: 'no' }),
      way('track', [P(-150, 0), P(150, 0)], { tracktype: 'grade3', access: 'private' }),
      way('residential', [P(0, 0), P(0, 120)], { name: 'High Street' }),
      way('cycleway', [P(500), P(600)], { name: 'Far away' }),
      way('platform', [P(0), P(10)]),
      { type: 'node', lat: 0, lon: 0 },
    ],
  }, C, 200);
  assert.deepEqual(roads.map((r) => `${r.kind} ${r.name}`), ['trail Ridge trail', 'trail Short walk', 'trail null', 'track null', 'road High Street']);
  const ridge = roads[0]!;
  near(ridge.length, 200, 1);
  assert.equal(ridge.lines.length, 2);
  assert.equal(ridge.difficulty, 'MTB S2');
  assert.ok(['dirt', 'rock'].includes(ridge.surface!));
  const track = roads.find((r) => r.kind === 'track')!;
  assert.equal(track.private, true);
  assert.equal(track.noBikes, false);
  assert.equal(track.difficulty, 'grade 3');
  near(track.length, 300, 1);
  assert.equal(roads[1]!.noBikes, true);
  assert.equal(roads[1]!.private, false);
  assert.equal(roadsGeoJson(roads).features.length, 5);
});

test('a reply that is not Overpass JSON is refused', () => {
  assert.throws(() => readOverpass({ hello: 1 }, C, 100), /unexpected/);
});

test('the query asks for roads and trails around the centre', () => {
  const q = overpassQuery([-0.47, 39.7], 1234.4);
  assert.match(q, /\[out:json\]/);
  assert.match(q, /around:1234,39\.700000,-0\.470000/);
  assert.match(q, /path\|footway/);
  assert.match(q, /out tags geom/);
});

test('distances read naturally', () => {
  assert.equal(distance(850), '850 m');
  assert.equal(distance(3420), '3.4 km');
  assert.equal(distance(12_600), '13 km');
});
