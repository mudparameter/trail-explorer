// Starts the app on data from before the config folder existed, and checks that
// added maps and layer settings move into it. Run: node test/e2e-migrate.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from 'playwright-core';
import electronPath from 'electron';
import { parseConfig } from '../src/core/config.ts';
import { Store } from '../src/desktop/store.ts';

const data = mkdtempSync(join(tmpdir(), 'te-migrate-'));
const OLD = '4b8f0d0e-0000-4000-8000-000000000001';

// A small image map, as an earlier version would have stored it.
mkdirSync(join(data, 'maps'));
const mapFile = join(data, 'maps', `${OLD}.mbtiles`);
const db = new DatabaseSync(mapFile);
db.exec("CREATE TABLE metadata (name, value); CREATE TABLE tiles (zoom_level, tile_column, tile_row, tile_data); INSERT INTO metadata VALUES ('format','png'),('bounds','-1,39,0,40')");
db.prepare('INSERT INTO tiles VALUES (1, 0, 1, ?)').run(Buffer.from('89504e470d0a1a0a00000000', 'hex'));
db.close();
const info = { id: OLD, name: 'Home trails', kind: 'raster', bounds: [-1, 39, 0, 40], minzoom: 1, maxzoom: 1, layers: [], attribution: 'Me' };
const store = new Store(join(data, 'trail-explorer.db'));
store.close();
const raw = new DatabaseSync(join(data, 'trail-explorer.db'));
raw.prepare('INSERT INTO map VALUES (?, ?, ?)').run(OLD, `${OLD}.mbtiles`, JSON.stringify(info));
// Old layer state: the map under the rides, Spain topo on and faded, world map off.
const layers = [
  { id: 'heatmap', on: true, opacity: 1 }, { id: OLD, on: true, opacity: 0.6 }, { id: 'ign', on: true, opacity: 0.5 },
  { id: 'opentopomap', on: false, opacity: 1 }, { id: 'openfreemap', on: false, opacity: 1 },
];
raw.prepare('INSERT INTO setting VALUES (?, ?)').run('layers', JSON.stringify(layers));
raw.close();

const app = await _electron.launch({ executablePath: electronPath as unknown as string, args: ['.', '--use-mock-keychain'], env: { ...process.env, TRAIL_TEST_DATA: data } as any });
const w = await app.firstWindow();
await w.getByText('needs your Garmin personal API key').waitFor();
await app.close();

const cfg = join(data, 'config');
const files = Object.fromEntries(['map.json', 'heatmap.json', 'layers.json'].map((f) => [f, readFileSync(join(cfg, f), 'utf8')]));
const { config, problems } = parseConfig(files);
assert.deepEqual(problems, []);
console.log(config.layers.map((l) => `${l.id} ${l.on} ${l.opacity}`).join('\n'));
assert.deepEqual(config.layers.map((l) => l.id), ['heatmap', 'roads', 'home-trails', 'ign', 'opentopomap', 'openfreemap']);
const home = config.layers[2]!;
assert.ok(home.type === 'file' && home.file === 'maps/home-trails.mbtiles' && home.name === 'Home trails' && home.opacity === 0.6 && home.on);
assert.ok(config.layers[3]!.on && config.layers[3]!.opacity === 0.5, 'Spain topo kept on and faded');
assert.equal(config.layers[5]!.on, false, 'world map kept off');
assert.ok(existsSync(join(cfg, 'maps', 'home-trails.mbtiles')), 'map moved into the config folder');
assert.deepEqual(readdirSync(join(data, 'maps')), [], 'old copy removed');
const after = new DatabaseSync(join(data, 'trail-explorer.db'));
assert.equal(after.prepare('SELECT count(*) AS n FROM map').get()!.n, 0);
assert.equal(after.prepare("SELECT count(*) AS n FROM setting WHERE k = 'layers'").get()!.n, 0);
after.close();
console.log('Migration E2E passed');
