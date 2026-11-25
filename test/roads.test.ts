import assert from 'node:assert/strict';
import test from 'node:test';
import { distance, overpassQuery, parseOverpass, readOverpass, roadsGeoJson, tileBounds, tileKey, tilesFor, tileXY } from '../src/core/roads.ts';
import { clipToShapes, rectFrom, type Shape } from '../src/core/shapes.ts';
import { M_PER_DEG } from '../src/core/track.ts';

const C: [number, number] = [0, 0];
/** A point `x` metres east and `y` metres north of the centre, on the equator. */
const P = (x: number, y = 0): [number, number] => [x / M_PER_DEG, y / M_PER_DEG];
let wid = 0;
const way = (highway: string, pts: [number, number][], tags: Record<string, string> = {}) => ({
  type: 'way', id: ++wid, tags: { highway, ...tags }, nodes: pts.map((_, i) => wid * 100 + i), geometry: pts.map(([lon, lat]) => ({ lon, lat })),
});
const circle = (center: [number, number], radius: number): Shape => ({ kind: 'circle', center, radius });
const clipToCircle = (line: [number, number][], center: [number, number], radius: number) => clipToShapes(line, [circle(center, radius)]);
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
  }, circle(C, 200));
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
  assert.throws(() => readOverpass({ hello: 1 }, circle(C, 100)), /unexpected/);
});

test('a circle touches the tiles it overlaps, and the query asks for them as boxes', () => {
  const c: [number, number] = [-0.47, 39.7];
  const small = tilesFor(circle(c, 100));
  assert.ok(small.length >= 1 && small.length <= 4);
  const big = tilesFor(circle(c, 5000));
  // About 0.94 km tiles here: a 10 km wide circle covers roughly π·5.3² ≈ 90 of them.
  assert.ok(big.length > 70 && big.length < 160, String(big.length));
  for (const k of small) assert.ok(big.includes(k), 'a bigger circle covers the smaller one');
  const [w, s, e, n] = tileBounds(small[0]!);
  assert.ok(w < e && s < n && e - w < 0.02);
  // Two tiles side by side become one box.
  const [x, y] = tileXY(small[0]!);
  const q = overpassQuery([tileKey(x, y), tileKey(x + 1, y), tileKey(x, y + 5)]);
  assert.equal(q.match(/way\[/g)!.length, 2);
  assert.match(q, /out geom;/);
  assert.match(q, /path\|footway/);
});

test('ways keep their node ids, and broken ones are left out', () => {
  const ways = parseOverpass({ elements: [
    { type: 'way', id: 1, tags: { highway: 'path' }, nodes: [10, 11], geometry: [{ lon: 0, lat: 0 }, { lon: 0.001, lat: 0 }] },
    { type: 'way', id: 2, tags: { highway: 'path' }, nodes: [10], geometry: [{ lon: 0, lat: 0 }, { lon: 0.001, lat: 0 }] },
    { type: 'way', id: 3, tags: { building: 'yes' }, nodes: [1, 2], geometry: [{ lon: 0, lat: 0 }, { lon: 0.001, lat: 0 }] },
  ] });
  assert.deepEqual(ways.map((w) => [w.id, w.nodes]), [[1, [10, 11]]]);
});

test('distances read naturally', () => {
  assert.equal(distance(850), '850 m');
  assert.equal(distance(3420), '3.4 km');
  assert.equal(distance(12_600), '13 km');
});

test('a line is clipped to several circles at once, counting overlaps once', () => {
  const a = circle(C, 200), b = circle(P(300), 200);
  // Across both: one piece from -200 to 500, since they overlap from 100 to 200.
  const r = clipToShapes([P(-500), P(800)], [a, b]);
  assert.equal(r.lines.length, 1);
  assert.ok(Math.abs(r.length - 700) < 0.01, String(r.length));
  // Apart: two pieces.
  const apart = clipToShapes([P(-500), P(1500)], [a, circle(P(1000), 200)]);
  assert.equal(apart.lines.length, 2);
  assert.ok(Math.abs(apart.length - 800) < 0.01);
});

test('a line is cut at the sides of a rectangle', () => {
  const box = rectFrom(P(-200, -100), P(200, 100));
  // Straight across: 400 m, cut at x = ±200.
  const across = clipToShapes([P(-500), P(500)], [box]);
  assert.equal(across.lines.length, 1);
  near(across.length, 400);
  near(across.lines[0]![0]![0] * M_PER_DEG, -200);
  near(across.lines[0]!.at(-1)![0] * M_PER_DEG, 200);
  // Corner to corner through it, on a slant.
  near(clipToShapes([P(-300, -150), P(300, 150)], [box]).length, Math.hypot(400, 200), 1);
  // In and out again through the top: two pieces.
  const zig = clipToShapes([P(-150), P(-150, 300), P(150, 300), P(150)], [box]);
  assert.equal(zig.lines.length, 2);
  near(zig.length, 200);
  // Passes by above it.
  assert.equal(clipToShapes([P(-500, 150), P(500, 150)], [box]).lines.length, 0);
  // A circle and a rectangle that overlap count the shared part once: -200 to 500.
  near(clipToShapes([P(-500), P(800)], [box, circle(P(300), 200)]).length, 700, 0.01);
});

test('a rectangle touches every tile in its box', () => {
  const c: [number, number] = [-0.47, 39.7];
  const big = tilesFor(rectFrom([c[0] - 0.05, c[1] - 0.03], [c[0] + 0.05, c[1] + 0.03]));
  const ks = big.map(tileXY);
  const xs = new Set(ks.map((k) => k[0])), ys = new Set(ks.map((k) => k[1]));
  assert.equal(big.length, xs.size * ys.size, 'a full grid');
  assert.deepEqual(big, [...big].sort((a, b) => a - b));
  // A circle that fits inside the box touches fewer tiles.
  const round = tilesFor(circle(c, 2500));
  assert.ok(round.every((k) => big.includes(k)) && round.length < big.length);
});
