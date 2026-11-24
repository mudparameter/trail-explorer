import assert from 'node:assert/strict';
import test from 'node:test';
import { addCircle, clipTrack, editCircle, parseZones, removeZone, zonesGeoJson } from '../src/core/zones.ts';
import { M_PER_DEG } from '../src/core/track.ts';

/** A line east along the equator from 0 to `m` metres, a point every 10 m. */
const east = (m: number) => Float64Array.from(Array.from({ length: m / 10 + 1 }, (_, i) => [(i * 10) / M_PER_DEG, 0]).flat());
const at = (m: number): [number, number] => [m / M_PER_DEG, 0];
const lengths = (t: Float64Array[]) => t.map((l) => Math.round(((l.at(-2)! - l[0]!) * M_PER_DEG) / 10) * 10);

const circle = (center: [number, number], radius: number, name?: string) => ({
  type: 'Feature', properties: { radius, ...(name ? { name } : {}) }, geometry: { type: 'Point', coordinates: center },
});

test('reads circles, polygons and multipolygons and says what it left out', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      circle([1, 2], 300, 'Home'),
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] } },
      circle([1, 2], 5),
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0]]] } },
    ],
  };
  const { zones, problems } = parseZones('zones/zones.geojson', JSON.stringify(fc), true);
  assert.deepEqual(zones.map((z) => [z.id, z.kind, z.name, z.editable]), [
    ['zones/zones.geojson#0', 'circle', 'Home', true],
    ['zones/zones.geojson#1', 'polygon', 'Zone 2', false],
    ['zones/zones.geojson#2', 'polygon', 'Zone 3', false],
  ]);
  assert.equal(problems.length, 4);
  assert.match(problems[0]!, /^Zone 4: a point needs "radius"/);
  assert.match(problems[2]!, /not LineString/);
  assert.match(problems[3]!, /closed ring/);
});

test('a bare geometry or single feature is a zone too', () => {
  assert.equal(parseZones('zones/a.json', JSON.stringify({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }), false).zones.length, 1);
  assert.equal(parseZones('zones/a.json', JSON.stringify(circle([0, 0], 100)), false).zones.length, 1);
  assert.match(parseZones('zones/a.json', '[]', false).problems[0]!, /Should be GeoJSON/);
  assert.match(parseZones('zones/a.json', '{', false).problems[0]!, /Not valid JSON/);
});

test('cuts a ride where it passes through a circle', () => {
  // Edges between sample points, so rounding cannot decide which side they fall on.
  const { zones } = parseZones('z', JSON.stringify(circle(at(500), 95)), false);
  const out = clipTrack([east(1000)], zones);
  assert.equal(out.length, 2);
  assert.deepEqual(lengths(out), [400, 400]);
  assert.ok(Math.abs(out[0]!.at(-2)! * M_PER_DEG - 400) < 0.01);
  assert.ok(Math.abs(out[1]![0]! * M_PER_DEG - 600) < 0.01);
});

test('drops a ride that starts and ends in a zone at both ends', () => {
  const { zones } = parseZones('z', JSON.stringify({ type: 'FeatureCollection', features: [circle(at(0), 195), circle(at(1000), 195)] }), false);
  assert.deepEqual(lengths(clipTrack([east(1000)], zones)), [600]);
  assert.deepEqual(clipTrack([east(300)], [...zones, ...parseZones('z', JSON.stringify(circle(at(300), 195)), false).zones]), []);
});

test('polygons with holes', () => {
  const m = (v: number) => v / M_PER_DEG;
  const outer = [[m(205), m(-50)], [m(795), m(-50)], [m(795), m(50)], [m(205), m(50)], [m(205), m(-50)]];
  const hole = [[m(405), m(-20)], [m(595), m(-20)], [m(595), m(20)], [m(405), m(20)], [m(405), m(-20)]];
  const { zones } = parseZones('z', JSON.stringify({ type: 'Polygon', coordinates: [outer, hole] }), false);
  // Outside, then the hole is kept, then outside again.
  assert.deepEqual(lengths(clipTrack([east(1000)], zones)), [200, 180, 200]);
});

test('rides away from every zone are passed through untouched', () => {
  const line = east(1000);
  const { zones } = parseZones('z', JSON.stringify(circle([10, 10], 1000)), false);
  assert.equal(clipTrack([line], zones)[0], line);
  assert.equal(clipTrack([line], []).length, 1);
});

test('the app adds, edits and removes circles and keeps other features', () => {
  const poly = { type: 'Feature', properties: { name: 'Hand drawn' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };
  let t = addCircle(JSON.stringify({ type: 'FeatureCollection', name: 'mine', features: [poly] }), { name: ' Home ', center: [-0.1234567891, 39.5], radius: 250.4 });
  let z = parseZones('zones/zones.geojson', t, true);
  assert.deepEqual(z.problems, []);
  assert.equal(JSON.parse(t).name, 'mine');
  const c = z.zones[1]!;
  assert.ok(c.kind === 'circle' && c.name === 'Home' && c.radius === 250 && c.center[0] === -0.123457 && c.editable);
  t = editCircle(t, 1, { radius: 500, center: [2, 3] });
  z = parseZones('zones/zones.geojson', t, true);
  assert.ok(z.zones[1]!.kind === 'circle' && z.zones[1]!.radius === 500 && z.zones[1]!.center[0] === 2 && z.zones[1]!.name === 'Home');
  assert.throws(() => editCircle(t, 0, { radius: 10 }), /changed in the file/);
  assert.throws(() => editCircle(t, 1, { radius: 1 }), /radius/);
  t = removeZone(t, 1);
  assert.deepEqual(parseZones('zones/zones.geojson', t, true).zones.map((x) => x.name), ['Hand drawn']);
  assert.throws(() => addCircle('{"type":"Polygon"}', { name: 'x', center: [0, 0], radius: 100 }), /not a FeatureCollection/);
  assert.equal(addCircle(undefined, { name: 'x', center: [0, 0], radius: 100 }).split('\n').length, 5);
});

test('zones draw as polygons', () => {
  const { zones } = parseZones('z', JSON.stringify(circle([0, 0], 100)), false);
  const g = zonesGeoJson(zones);
  const ring = (g.features[0]!.geometry as any).coordinates[0];
  assert.equal(ring.length, 73);
  assert.deepEqual(ring[0], ring.at(-1));
});
