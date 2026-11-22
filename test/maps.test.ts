import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zipSync } from 'fflate';
import { layersIn, Maps, tileX, tileY } from '../src/desktop/maps.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'te-maps-'));
const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');
function rasterFile(dir: string) {
  const f = join(dir, 'My trails.mbtiles');
  const db = new DatabaseSync(f);
  db.exec("CREATE TABLE metadata (name, value); CREATE TABLE tiles (zoom_level, tile_column, tile_row, tile_data); INSERT INTO metadata VALUES ('format','png'),('bounds','-1,39,0,40'),('attribution','<b>Me</b>')");
  db.prepare('INSERT INTO tiles VALUES (1, 0, 1, ?)').run(PNG);
  db.close();
  return f;
}

test('image map: added, served, renamed safely, removed', async () => {
  const d = tmp(), m = new Maps(join(d, 'maps'));
  const { info } = await m.add(rasterFile(d));
  assert.equal(info.kind, 'raster');
  assert.equal(info.name, 'My trails');
  assert.equal(info.attribution, 'Me');
  assert.deepEqual(info.bounds, [-1, 39, 0, 40]);
  assert.equal((await m.tile(info.id, 1, 0, 0))?.type, 'image/png');
  assert.equal(await m.tile(info.id, 1, 1, 1), null);
  assert.equal(await m.tile('../../etc', 0, 0, 0), null);
  await m.remove(info.id);
  assert.deepEqual(readdirSync(join(d, 'maps')), []);
});
test('zip with a map inside', async () => {
  const d = tmp(), m = new Maps(join(d, 'maps'));
  const { readFileSync } = await import('node:fs');
  const z = join(d, 'x.zip');
  writeFileSync(z, zipSync({ 'a/README.txt': Buffer.from('hi'), 'a/../../evil.mbtiles': readFileSync(rasterFile(d)) }));
  const { info, file } = await m.add(z);
  assert.equal(info.name, 'evil');
  assert.ok(existsSync(join(d, 'maps', file)));
  assert.ok(!existsSync(join(d, 'evil.mbtiles')));
});
for (const [name, data] of [['Garmin .img', Buffer.from('DSKIMG rubbish rubbish')], ['.osm.pbf', Buffer.from('000000OSMHeader rubbish')], ['empty', Buffer.alloc(0)],
  ['broken sqlite', Buffer.from('SQLite format 3\0 rubbish')], ['broken pmtiles', Buffer.concat([Buffer.from('PMTiles\x03'), Buffer.alloc(200)])], ['zip without a map', Buffer.from(zipSync({ 'a.txt': Buffer.from('x') }))],
] as const) test(`refuses ${name} and leaves nothing behind`, async () => {
  const d = tmp(), m = new Maps(join(d, 'maps'));
  const f = join(d, 'f'); writeFileSync(f, data);
  await assert.rejects(m.add(f), (e: Error) => e.message.length > 20);
  assert.deepEqual(readdirSync(join(d, 'maps')), []);
});

// Real BBBike files: BBBIKE=folder npm test
const real = process.env.BBBIKE;
for (const ext of ['pmtiles', 'mbtiles']) test(`real BBBike ${ext}`, { skip: !real }, async () => {
  const d = tmp(), m = new Maps(d);
  const t = performance.now();
  const { info } = await m.add(join(real!, `CraterLake.osm.${ext}-shortbread.zip`));
  console.log(ext, info.name, info.kind, info.bounds, info.maxzoom, `${Math.round(performance.now() - t)} ms`);
  assert.equal(info.kind, 'shortbread');
  assert.ok(info.bounds[2] < -118, 'does not reach longitude 0');
  const tile = await m.tile(info.id, 13, tileX(-122.17, 13), tileY(42.9, 13));
  assert.ok(layersIn(tile!.data).includes('streets'));
  await m.close();
});
