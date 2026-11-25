import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { configZip, isConfigPath, readConfigZip } from '../src/core/configzip.ts';
import { DEFAULTS, FILES, fileText } from '../src/core/config.ts';
import { ConfigDir } from '../src/desktop/configdir.ts';

const ROUTES = JSON.stringify({ routes: [{ id: 'abcd1234', name: 'Loop', created: '2026-01-01T00:00:00.000Z', loop: true, start: [0, 0], distance: 5000, gain: 100, loss: 100, maxUp: 5, maxDown: 5, difficulty: 'Easy', fresh: 5000 }] });
const config = () => ({
  ...Object.fromEntries(FILES.map((f) => [f, fileText(f, DEFAULTS)])),
  'areas.json': JSON.stringify({ areas: [{ id: 'a1', center: [-0.47, 39.7], radius: 1500 }, { id: 'r1', box: [-0.5, 39.6, -0.45, 39.65] }] }),
  'routes.json': ROUTES,
  'routes/abcd1234.gpx': '<gpx></gpx>',
  'zones/zones.geojson': '{"type":"FeatureCollection","features":[]}',
});

test('a config .zip holds the config files and a README, and reads back the same', () => {
  const files = config();
  const zip = configZip({ ...files, 'secret.txt': 'not config', 'maps/x.pmtiles': 'nope', '../escape.json': '{}' });
  const inside = Object.keys(unzipSync(zip)).sort();
  assert.deepEqual(inside, ['README.md', ...Object.keys(files)].sort());
  const back = readConfigZip(zip);
  assert.deepEqual(back.files, files);
  assert.deepEqual(back.skipped, []);
  assert.deepEqual(back.problems, []);
});

test('a .zip of the config folder itself works, and what is not config is left out', () => {
  const z: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(config())) z[`My config/${k}`] = strToU8(v);
  z['My config/notes.txt'] = strToU8('hi');
  z['__MACOSX/My config/._map.json'] = strToU8('junk');
  const r = readConfigZip(zipSync(z));
  assert.deepEqual(Object.keys(r.files).sort(), Object.keys(config()).sort());
  assert.deepEqual(r.skipped, ['notes.txt']);
  // Map files only when asked for.
  const withMap = zipSync({ 'map.json': strToU8('{}'), 'maps/region.pmtiles': new Uint8Array([1, 2, 3]) });
  assert.deepEqual(readConfigZip(withMap).maps, {});
  assert.deepEqual([...readConfigZip(withMap, { withMaps: true }).maps['maps/region.pmtiles']!], [1, 2, 3]);
});

test('anything that is not a config is refused, and problems in one are reported', () => {
  assert.throws(() => readConfigZip(strToU8('not a zip')), /not a \.zip/);
  assert.throws(() => readConfigZip(zipSync({ 'photo.jpg': new Uint8Array(10), 'README.md': strToU8('#') })), /no Trail Explorer config/);
  const r = readConfigZip(zipSync({ 'areas.json': strToU8('{"areas": [{"center": [0, 0], "radius": 5}]}') }));
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0]!.message, /radius/);
  // Paths that could escape the folder never count as config.
  for (const p of ['../map.json', '/map.json', 'routes/../../x.gpx', 'routes/ABC.gpx', 'zones/a/b.geojson']) assert.equal(isConfigPath(p), false, p);
});

test('the desktop config folder exports and imports the same .zip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-cfgzip-'));
  const d = new ConfigDir(dir);
  await d.create(DEFAULTS);
  mkdirSync(join(dir, 'routes'));
  writeFileSync(join(dir, 'routes.json'), ROUTES);
  writeFileSync(join(dir, 'routes', 'abcd1234.gpx'), '<gpx>old</gpx>');
  writeFileSync(join(dir, 'routes', 'zzzz9999.gpx'), '<gpx>gone</gpx>');
  mkdirSync(join(dir, 'maps'), { recursive: true });
  writeFileSync(join(dir, 'maps', 'region.pmtiles'), 'map');
  const out = readConfigZip(configZip(await d.allFiles()));
  assert.equal(out.files['routes/abcd1234.gpx'], '<gpx>old</gpx>');
  assert.equal(out.files['map.json'], readFileSync(join(dir, 'map.json'), 'utf8'));

  // Importing a config from the website: its files replace these, routes it doesn't list go, map files stay.
  const web = config();
  await d.importFiles({ ...web, 'routes/abcd1234.gpx': '<gpx>new</gpx>' });
  assert.equal(readFileSync(join(dir, 'routes', 'abcd1234.gpx'), 'utf8'), '<gpx>new</gpx>');
  assert.equal(existsSync(join(dir, 'routes', 'zzzz9999.gpx')), false);
  assert.equal(readFileSync(join(dir, 'maps', 'region.pmtiles'), 'utf8'), 'map');
  const loaded = await d.load();
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded.config.areas.map((a) => a.shape.kind), ['circle', 'rect']);
});
