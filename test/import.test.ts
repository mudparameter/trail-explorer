import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync, zipSync } from 'fflate';
import { readGpx, readTcx, startMs } from '../src/core/import.ts';
import { rideFilesIn } from '../src/desktop/zipread.ts';
import { crc32, deflateRawSync } from 'node:zlib';
import { readFile } from '../src/core/ride.ts';
import { Importer } from '../src/desktop/importer.ts';
import { Store } from '../src/desktop/store.ts';
import { fit } from './fake-garmin.ts';

const line = (n: number, lon = -0.47): [number, number][] => Array.from({ length: n }, (_, i) => [lon + i * 0.0001, 39.7]);
const text = (s: string) => new TextEncoder().encode(s);

const gpx = (start: string) => text(`<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><metadata><time>${start}</time></metadata>
<trk><name>Evening</name><type>cycling</type><trkseg>
${line(40, -0.3).map(([lon, lat], i) => `<trkpt lat="${lat}" lon="${lon}"><ele>100</ele><time>${new Date(Date.parse(start) + i * 2000).toISOString()}</time></trkpt>`).join('\n')}
<trkpt lat="999" lon="1"/></trkseg></trk></gpx>`);
const tcx = (start: string) => text(`<TrainingCenterDatabase><Activities><Activity Sport="Biking"><Id>${start}</Id><Lap StartTime="${start}"><Track>
${line(40, -0.2).map(([lon, lat], i) => `<Trackpoint><Time>${new Date(Date.parse(start) + i * 2000).toISOString()}</Time><Position><LatitudeDegrees>${lat}</LatitudeDegrees><LongitudeDegrees>${lon}</LongitudeDegrees></Position></Trackpoint>`).join('\n')}
<Trackpoint><Time>${start}</Time></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>`);

test('start times from Garmin, files and other places compare as the same moment', () => {
  assert.equal(startMs('2025-05-01 08:00:00'), Date.parse('2025-05-01T08:00:00Z'));
  assert.equal(startMs('2025-05-01T10:00:00+02:00'), Date.parse('2025-05-01T08:00:00Z'));
  assert.equal(startMs('2025-05-01T08:00:00.000Z'), Date.parse('2025-05-01T08:00:00Z'));
  assert.equal(startMs(''), null);
  assert.equal(startMs('soon'), null);
});

test('GPX and TCX files are read', () => {
  const g = readGpx(new TextDecoder().decode(gpx('2025-06-01T07:00:00Z')));
  assert.equal(g.points.length, 40);
  assert.equal(g.sport, 'cycling');
  assert.equal(g.startedAt, '2025-06-01T07:00:00.000Z');
  const t = readTcx(new TextDecoder().decode(tcx('2025-06-02T07:00:00Z')));
  assert.equal(t.points.length, 40);
  assert.equal(t.sport, 'biking');
  assert.equal(t.startedAt, '2025-06-02T07:00:00.000Z');
});

/**
 * A zip written the way Garmin writes the zips inside its export: each entry's
 * sizes come after its data, so a reader going from the start can't tell where
 * the entry ends. Data that looks like a zip header inside an entry makes
 * that worse.
 */
function streamedZip(files: Record<string, Uint8Array>): Uint8Array {
  const parts: Buffer[] = [];
  const dir: Buffer[] = [];
  let at = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(n.length, 26);
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc, 4); desc.writeUInt32LE(packed.length, 8); desc.writeUInt32LE(data.length, 12);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(at, 42);
    dir.push(c, n);
    parts.push(local, n, packed, desc);
    at += 30 + n.length + packed.length + 16;
  }
  const cd = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, cd, end]);
}

async function found(zip: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), 'te-zip-'));
  writeFileSync(join(dir, 'x.zip'), zip);
  const out = [];
  for await (const f of rideFilesIn(join(dir, 'x.zip'), dir)) out.push(f);
  assert.deepEqual(readdirSync(dir), ['x.zip'], 'inner zips are deleted');
  return out;
}

test('ride files are found in zips inside zips, gzipped or not, as Garmin and Strava export them', async () => {
  // Stored without compression, so the inner zip's headers appear as-is in the outer one's data.
  const inner = streamedZip({ 'a@b.c_1.fit': fit(line(30)), 'a@b.c_2.fit': fit(line(30, -0.4)), 'notes.txt': text('PK\x03\x04 hi') });
  const outer = zipSync({
    'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip': inner,
    'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part2.zip': [inner, { level: 0 }],
    'activities/2.gpx.gz': gzipSync(gpx('2025-06-01T07:00:00Z')),
    'activities/3.tcx': tcx('2025-06-02T07:00:00Z'),
    'media/photo.jpg': new Uint8Array(5000),
  });
  const fs = await found(outer);
  const P = 'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part';
  assert.deepEqual(fs.map((f) => f.name).sort(), [`${P}1.zip/a@b.c_1.fit`, `${P}1.zip/a@b.c_2.fit`, `${P}2.zip/a@b.c_1.fit`, `${P}2.zip/a@b.c_2.fit`, 'activities/2.gpx.gz', 'activities/3.tcx']);
  for (const f of fs) assert.equal((await readFile(f.name, f.data)).status, 'done', f.name);
  assert.equal((await readFile('2.gpx.gz', fs.find((f) => f.name.endsWith('.gz'))!.data)).startedAt, '2025-06-01T07:00:00.000Z');
  await assert.rejects(found(text('not a zip at all, sorry')), /not a \.zip/);
});

test('importing adds only new rides, keeps no copy of the zip, and Garmin does not download them again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-import-'));
  const store = new Store(join(dir, 'db'));
  const ridesDir = join(dir, 'rides');
  // A ride already synced from Garmin, started 08:00 UTC.
  store.addRides([{ id: '111', startedAt: '2025-05-01 08:00:00', sport: 'cycling', name: 'Synced', distance: 1000 }]);
  const zip = join(dir, 'export.zip');
  writeFileSync(zip, zipSync({
    'synced-again.fit': fit(line(30), '2025-05-01T08:00:30Z'), // the Garmin ride, 30 s off: the same ride
    'new.fit': fit(line(30, -0.4), '2025-05-02T08:00:00Z'),
    'new-copy.fit': fit(line(30, -0.4), '2025-05-02T08:00:00Z'), // the same file twice
    'evening.gpx': gpx('2025-05-03T18:00:00Z'),
    'broken.fit': text('nope'),
    'health.fit': fit([]), // a FIT file that is not an activity
  }));
  let rebuilds = 0;
  const imp = new Importer({ store, ridesDir, tmpDir: join(dir, 'tmp'), readFile, ridesChanged: () => rebuilds++, changed: () => {} });
  const s = await imp.run(zip);
  assert.equal(s.state, 'done', s.message);
  assert.deepEqual({ found: s.found, added: s.added, had: s.had, unread: s.unread, other: s.other }, { found: 6, added: 2, had: 2, unread: 1, other: 1 });
  assert.match(s.message, /2 new rides added, 2 rides already here, 1 could not be read, 1 other file \(such as daily health data\) left out/);
  assert.equal(rebuilds, 1);
  assert.equal(store.counts().done, 2);
  assert.equal(store.tracks().length, 2);
  // Only the new rides are kept, each on its own.
  assert.deepEqual(readdirSync(ridesDir).filter((f) => !f.startsWith('file-')), []);
  assert.equal(readdirSync(ridesDir).length, 2);

  // The same export again adds nothing.
  const again = await imp.run(zip);
  assert.equal(again.added, 0);
  assert.equal(again.had, 4);

  // Garmin later lists the imported rides: they are noted, not downloaded.
  const n = store.addRides([
    { id: '222', startedAt: '2025-05-02 08:01:00', sport: 'cycling', name: 'From Garmin', distance: 1000 },
    { id: '333', startedAt: '2025-05-04 08:00:00', sport: 'cycling', name: 'Really new', distance: 1000 },
  ]);
  assert.equal(n, 1);
  assert.equal(store.nextWaiting()?.id, '333');
  assert.equal(store.counts().total, 4, 'the noted ride is not counted twice');
  store.close();

  // Start times are kept for databases from before imports existed, too.
  const reopened = new Store(join(dir, 'db'));
  assert.ok(reopened.near(Date.parse('2025-05-01T08:01:00Z')));
  reopened.close();
});
