import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { bandLabels, checkFile, DEFAULTS, FILES, fileText, mapOrigins, parseConfig, prettyJson } from '../src/core/config.ts';

const parse = (files: Record<string, unknown>) =>
  parseConfig(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));

test('an empty folder gives the defaults and no problems', () => {
  const { config, problems } = parse({});
  assert.deepEqual(config, DEFAULTS);
  assert.deepEqual(problems, []);
});

test('the default files read back as the defaults', () => {
  const files = Object.fromEntries(FILES.map((f) => [f, fileText(f, DEFAULTS)]));
  const { config, problems } = parseConfig(files);
  assert.deepEqual(problems, []);
  assert.deepEqual(config, DEFAULTS);
});

test('config.example has no problems', () => {
  const root = join(import.meta.dirname, '..', 'config.example');
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(root, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  const { config, problems } = parseConfig(files);
  assert.deepEqual(problems, []);
  assert.ok(config.zones.length > 0);
});

test('keys starting with // are comments', () => {
  const { problems } = parse({ 'map.json': { '//': 'hello', '// more': 'x', zoom: 3 } });
  assert.deepEqual(problems.map((p) => p.message), ['"zoom" is not a setting here, so it is ignored.']);
});

test('a bad value falls back to its default and the rest is kept', () => {
  const { config, problems } = parse({ 'map.json': { view: { center: [500, 0], zoom: 4 }, background: '#123456', maxZoom: 'big' } });
  assert.equal(config.map.view, null);
  assert.equal(config.map.background, '#123456');
  assert.equal(config.map.maxZoom, DEFAULTS.map.maxZoom);
  assert.equal(problems.length, 2);
  assert.match(problems[0]!.message, /"view" has "center", which should be \[longitude, latitude\]/);
  assert.match(problems[1]!.message, /"maxZoom" should be a number from 0 to 22/);
  assert.ok(problems.every((p) => p.file === 'map.json'));
});

test('broken JSON is reported and the defaults are used', () => {
  const { config, problems } = parse({ 'heatmap.json': '{ "bands": [ }' });
  assert.deepEqual(config.heatmap, DEFAULTS.heatmap);
  assert.equal(problems[0]!.file, 'heatmap.json');
  assert.match(problems[0]!.message, /^Not valid JSON/);
});

test('bands must start at 1 and go up', () => {
  assert.match(parse({ 'heatmap.json': { bands: [{ from: 2, color: '#000' }] } }).problems[0]!.message, /start with a band "from": 1/);
  assert.match(parse({ 'heatmap.json': { bands: [{ from: 1, color: '#000' }, { from: 1, color: '#fff' }] } }).problems[0]!.message, /should go up: item 2/);
  assert.match(parse({ 'heatmap.json': { bands: [{ from: 1, color: 'red' }] } }).problems[0]!.message, /item 1: "color" should be a colour/);
  const ok = parse({ 'heatmap.json': { bands: [{ from: 1, color: '#ABC' }, { from: 5, color: '#000000', label: 'lots' }] } });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.config.heatmap.bands, [{ from: 1, color: '#abc' }, { from: 5, color: '#000000', label: 'lots' }]);
});

test('band labels are made from the numbers', () => {
  assert.deepEqual(bandLabels(DEFAULTS.heatmap.bands), ['1', '2 to 3', '4 to 7', '8 to 15', '16 to 39', '40 or more']);
  assert.deepEqual(bandLabels([{ from: 1, color: '#000', label: 'Once' }, { from: 2, color: '#fff' }]), ['Once', '2 or more']);
});

test('bad layers are left out, good ones kept, and there is always one heatmap', () => {
  const { config, problems } = parse({
    'layers.json': {
      layers: [
        { id: 'web', type: 'raster', name: 'Web', tiles: ['http://insecure.example/{z}/{x}/{y}.png'] },
        { id: 'sub', type: 'raster', tiles: ['https://{s}.example.org/{z}/{x}/{y}.png'] },
        { id: 'ok', type: 'raster', name: 'OK', tiles: ['https://tiles.example.org/{z}/{x}/{y}.png'], maxzoom: 15, colour: 'x' },
        { id: 'ok', type: 'openfreemap' },
        { id: 'Bad Id', type: 'openfreemap' },
        { id: 'f', type: 'file', file: '../../etc/passwd.pmtiles' },
        { id: 'g', type: 'file', file: 'maps/home.pmtiles', opacity: 0.5, on: false },
        { id: 'x', type: 'vector' },
      ],
    },
  });
  assert.deepEqual(config.layers.map((l) => l.id), ['heatmap', 'ok', 'g']);
  const ok = config.layers[1]!;
  assert.ok(ok.type === 'raster' && ok.maxzoom === 15 && ok.minzoom === 0 && ok.tileSize === 256);
  assert.deepEqual(config.layers[2], { id: 'g', type: 'file', name: 'g', on: false, opacity: 0.5, file: 'maps/home.pmtiles' });
  const m = problems.map((p) => p.message).join('\n');
  for (const s of ['does not start with https', 'instead of using {s}', 'Layer "ok": "colour" is not a setting', 'id "ok" is used twice', 'short name of lower-case', '"file" should be a map in the maps folder', '"type" should be one of']) {
    assert.ok(m.includes(s), `missing: ${s}\n${m}`);
  }
});

test('a heatmap layer moved down stays there', () => {
  const { config } = parse({ 'layers.json': { layers: [{ id: 'openfreemap', type: 'openfreemap' }, { id: 'heatmap', type: 'heatmap' }] } });
  assert.deepEqual(config.layers.map((l) => l.id), ['openfreemap', 'heatmap']);
});

test('map origins for the security policy', () => {
  assert.deepEqual(mapOrigins(DEFAULTS.layers), ['https://a.tile.opentopomap.org', 'https://b.tile.opentopomap.org', 'https://c.tile.opentopomap.org', 'https://tiles.openfreemap.org', 'https://www.ign.es']);
});

test('checkFile reports problems for one file', () => {
  assert.deepEqual(checkFile('map.json', DEFAULTS.map), []);
  assert.equal(checkFile('map.json', { ...DEFAULTS.map, minZoom: 30 }).length, 1);
});

test('rewriting a file keeps its comments and unknown keys stay reported', () => {
  const before = '{ "// mine": "keep me", "background": "#000000" }';
  const after = fileText('map.json', { ...DEFAULTS, map: { ...DEFAULTS.map, background: '#ffffff' } }, before);
  assert.equal(JSON.parse(after)['// mine'], 'keep me');
  assert.equal(JSON.parse(after).background, '#ffffff');
  assert.equal(JSON.parse(after)['//'], undefined);
});

test('pretty JSON keeps short things on one line and reads back the same', () => {
  const v = { a: [1, 2, 3], b: { c: 'x "quoted": y, z', d: null }, long: Array.from({ length: 30 }, (_, i) => ({ i, s: 'abcdef' })) };
  const t = prettyJson(v);
  assert.deepEqual(JSON.parse(t), v);
  assert.ok(t.includes('"a": [1, 2, 3]'));
  assert.ok(t.split('\n').every((l) => l.length <= 100));
});

test('config.example/README.md is the README the app writes', async () => {
  const { CONFIG_README } = await import('../src/core/config-readme.ts');
  assert.equal(readFileSync(join(import.meta.dirname, '..', 'config.example', 'README.md'), 'utf8'), CONFIG_README);
});
