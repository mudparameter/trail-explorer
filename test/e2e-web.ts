// Drives the website build (out/web) as a page on another site would use it: a
// host page with its own styles loads trail-explorer.js and the
// <trail-explorer> element. Fake Overpass and elevation servers, as in
// e2e-planner.ts. Runs in Electron's Chromium as a plain browser window.
// Run: npm run build:web && SHOTS=folder node test/e2e-web.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Page } from 'playwright-core';
import { fit } from './fake-garmin.ts';
import { browserData, closeServers, GAP, HALF, launch as open, MID, overpass, Q, terrain } from './web-servers.ts';

const shots = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), 'te-shots-'));

const data = browserData();
const launch = () => open(data);
let app = await launch();
let w: Page = await app.firstWindow();
const logs: string[] = [];
const watch = () => {
  w.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  w.on('pageerror', (e) => logs.push('PAGE ' + e.message));
};
watch();
const shot = (n: string) => w.screenshot({ path: join(shots, `w${n}.png`) });
/** Catches the next file the page hands the browser to save, instead of saving it. */
const nextDownload = () => w.evaluate(() => new Promise<{ name: string; bytes: number[] }>((done) => {
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    HTMLAnchorElement.prototype.click = click;
    void fetch(this.href).then((r) => r.arrayBuffer()).then((b) => done({ name: this.download, bytes: [...new Uint8Array(b)] }));
  };
}));
const backup = () => w.evaluate(async () => {
  const db = await new Promise<IDBDatabase>((ok) => { const r = indexedDB.open('trail-explorer'); r.onsuccess = () => ok(r.result); });
  return new Promise<any>((ok) => { const r = db.transaction('meta').objectStore('meta').get('backup'); r.onsuccess = () => ok(r.result); });
});

try {
  // The app starts in the page, with no Garmin key asked for.
  await w.getByRole('heading', { name: 'Roads and trails' }).waitFor({ timeout: 30000 });
  assert.equal(await w.getByLabel('Garmin personal API key').count(), 0, 'no Garmin key on the website');
  // Rides come from an export .zip, not Garmin sync.
  await w.getByRole('button', { name: 'Import rides…' }).waitFor();
  assert.equal(await w.getByRole('button', { name: 'Sync now' }).count(), 0, 'no Garmin sync');
  await w.getByText('0 rides on the map').waitFor();
  await w.getByRole('heading', { name: 'Excluded zones' }).waitFor();
  assert.equal(await w.getByRole('button', { name: 'Add map' }).count(), 0, 'no map files yet');
  // The host page's styles stay out: the app's buttons are not pink, and its text is not Georgia.
  const look = await w.getByRole('button', { name: 'Draw a circle' }).evaluate((b) => [getComputedStyle(b).backgroundColor, getComputedStyle(b).fontFamily]);
  assert.notEqual(look[0], 'rgb(255, 105, 180)');
  assert.doesNotMatch(look[1], /Georgia/);
  // The map's styles and fonts load from beside the script.
  await w.waitForFunction(() => (window as any).__map?.isStyleLoaded?.(), null, { timeout: 30000 });
  await shot('1-start');

  // Draw an area over the grid. Its roads come straight from Overpass.
  await w.evaluate(([x, y]) => (window as any).__map.jumpTo({ center: [x, y], zoom: 13 }), MID);
  await w.waitForTimeout(400);
  const mb = (await w.locator('.map').boundingBox())!;
  const mid = await w.evaluate(([x, y]) => (window as any).__map.project([x, y]), MID);
  const edge = await w.evaluate(([x, y]) => (window as any).__map.project([x, y]), Q(1400, 0));
  await w.getByRole('button', { name: 'Draw a circle' }).click();
  await w.mouse.click(mb.x + mid.x, mb.y + mid.y);
  await w.mouse.move(mb.x + edge.x, mb.y + edge.y, { steps: 4 });
  await w.mouse.click(mb.x + edge.x, mb.y + edge.y);
  await w.locator('.areas > li').first().getByText(/trails/).waitFor({ timeout: 30000 });
  const calls = overpass.calls;
  assert.ok(calls > 0);
  await w.waitForTimeout(500);
  await shot('2-area');

  // Plan routes, with elevation, in the page's worker.
  await w.getByRole('button', { name: 'Route planner →' }).click();
  await w.getByRole('button', { name: 'Use these areas' }).click();
  await w.getByText('Click the map to place the start.').first().waitFor({ timeout: 30000 });
  assert.ok(terrain.tiles > 0, 'elevation downloaded');
  assert.equal(await w.getByLabel('Include my favourite trails').count(), 0, 'no favourites without rides');
  await w.waitForTimeout(500);
  const pb = (await w.locator('.map').boundingBox())!;
  const at = await w.evaluate(([x, y]) => (window as any).__planMap.project([x, y]), Q(-200, -150));
  await w.mouse.click(pb.x + at.x, pb.y + at.y);
  await w.getByLabel('Distance', { exact: true }).fill('6');
  await w.getByLabel('Include a long descent').check();
  await w.getByLabel('Descent length').fill('1');
  await w.getByRole('button', { name: 'Plan routes' }).click();
  await w.locator('.route-card').nth(1).waitFor({ timeout: 60000 });
  const cards = await w.locator('.route-card').allInnerTexts();
  console.log(cards.map((t) => `${t.match(/Distance\s*([\d.]+) km/)?.[1]} km, ${t.match(/Long descent\s*([\d.]+) km/)?.[1]} km descent`).join(' | '));
  assert.ok(cards.every((t) => /Long descent/.test(t) && /↑ \d+ m/.test(t)), 'routes with elevation and a descent');
  await shot('3-routes');

  // Save one, and download its GPX.
  await w.locator('.route-card').first().getByRole('button', { name: 'Save…' }).click();
  await w.getByLabel('Route name').fill('Web loop');
  await w.locator('.route-card').first().getByRole('button', { name: 'Save', exact: true }).click();
  await w.getByText('Saved as “Web loop”.').waitFor();
  await w.getByRole('button', { name: 'Saved routes' }).click();
  await w.getByRole('heading', { name: 'Saved routes' }).waitFor();
  await w.getByText('Web loop').first().waitFor();
  const gpxDown = nextDownload();
  await w.locator('table.routes tbody tr').first().getByRole('button', { name: /Download/ }).click();
  const gpx = await gpxDown;
  assert.equal(gpx.name, 'Web loop.gpx');
  assert.match(Buffer.from(gpx.bytes).toString(), /<name>Web loop<\/name>[\s\S]*<ele>/);
  await shot('4-saved');

  // Changes only in the browser: counted, and a reminder once there are ten.
  const b1 = await backup();
  console.log('changes not exported:', b1.unsaved);
  assert.ok(b1.unsaved >= 3 && b1.since);
  await w.getByRole('button', { name: 'Map', exact: true }).click();
  for (let i = 0; b1.unsaved + i < 10; i++) {
    await w.locator('.areas > li').first().getByRole('checkbox').first().click();
    await w.waitForTimeout(150);
  }
  await w.getByText(/to your config are only in this browser/).waitFor();
  await shot('5-reminder');

  // Export: a .zip laid out like the config folder.
  const zipDown = nextDownload();
  await w.locator('.notice').getByRole('button', { name: 'Export config' }).click();
  const zip = await zipDown;
  assert.match(zip.name, /^trail-explorer-config-\d{4}-\d{2}-\d{2}\.zip$/);
  const files = unzipSync(new Uint8Array(zip.bytes));
  console.log('exported:', Object.keys(files).sort().join(' '));
  for (const f of ['README.md', 'map.json', 'layers.json', 'heatmap.json', 'areas.json', 'routes.json']) assert.ok(files[f], f);
  assert.ok(Object.keys(files).some((f) => /^routes\/[a-z0-9]+\.gpx$/.test(f)));
  const areasJson = JSON.parse(strFromU8(files['areas.json']!));
  assert.equal(areasJson.areas.length, 1);
  await w.getByText(/to your config are only in this browser/).waitFor({ state: 'detached' });
  assert.equal((await backup()).unsaved, 0);

  // Everything is still there after closing the browser, and nothing is downloaded again.
  await app.close();
  app = await launch();
  w = await app.firstWindow();
  watch();
  await w.locator('.areas > li').first().getByText(/trails/).waitFor({ timeout: 30000 });
  assert.equal(overpass.calls, calls, 'road data kept in the browser');
  await w.getByRole('button', { name: 'Routes', exact: true }).click();
  await w.getByText('Web loop').first().waitFor();

  // Import: a config made elsewhere (here, the export with the area renamed and a second area) replaces it.
  areasJson.areas[0].name = 'Imported hill';
  areasJson.areas.push({ id: 'second', name: 'Second', box: [Q(-600, -600)[0], Q(-600, -600)[1], Q(600, 600)[0], Q(600, 600)[1]] });
  const changed = zipSync({ ...files, 'areas.json': strToU8(JSON.stringify(areasJson)), 'notes.txt': strToU8('not config') });
  await w.getByRole('button', { name: 'Customize' }).click();
  await w.getByLabel('Config .zip to import').setInputFiles({ name: 'mine.zip', mimeType: 'application/zip', buffer: Buffer.from(changed) });
  await w.getByRole('button', { name: 'Replace' }).click();
  await w.getByText(/Imported \d+ files from mine\.zip\. Left out 1 that is not part of a config\./).waitFor();
  await w.getByRole('button', { name: 'Map', exact: true }).click();
  await w.getByText('Imported hill').waitFor();
  await w.getByText('Second').waitFor();
  await w.locator('.areas > li').nth(1).getByText(/trails/).waitFor({ timeout: 30000 });
  assert.equal(overpass.calls, calls, 'the second area is inside the first: no new download');
  await shot('6-imported');

  // A broken .zip is refused, and the config stays.
  await w.getByRole('button', { name: 'Customize' }).click();
  await w.getByLabel('Config .zip to import').setInputFiles({ name: 'bad.zip', mimeType: 'application/zip', buffer: Buffer.from('nope') });
  await w.getByRole('button', { name: 'Replace' }).click();
  await w.getByText('That file is not a .zip, or it is damaged.').waitFor();

  // Rides from an export .zip, read in the browser: a Garmin-style export, rides in a zip inside it.
  // Rows 2 to 8 ridden along their western half; row 4 four times, so it is a favourite.
  const ride = (j: number) => Array.from({ length: 200 }, (_, i) => Q(-HALF + (i / 199) * HALF, j * GAP - HALF));
  const rideFiles = Object.fromEntries([2, 4, 6, 8, 4, 4, 4].map((j, i) => [`a@b.c_${i}.fit`, fit(ride(j), `2025-0${i + 1}-01T08:00:00Z`)]));
  const exportZip = zipSync({ 'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip': zipSync(rideFiles), 'media/photo.jpg': new Uint8Array(1000) });
  await w.getByRole('button', { name: 'Map', exact: true }).click();
  const chooser = w.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Import rides…' }).click();
  await (await chooser).setFiles({ name: 'export.zip', mimeType: 'application/zip', buffer: Buffer.from(exportZip) });
  await w.getByText('7 new rides added.').waitFor({ timeout: 60000 });
  await w.getByText('7 rides on the map').waitFor();
  await w.evaluate(([x, y]) => (window as any).__map.jumpTo({ center: [x, y], zoom: 13 }), MID);
  await w.waitForFunction(() => (window as any).__map.getLayer('heat') && (window as any).__map.querySourceFeatures('heatmap').length > 0, null, { timeout: 30000 });
  await w.waitForTimeout(600);
  await shot('7-rides');
  // The same .zip again adds nothing.
  const again = w.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Import rides…' }).click();
  await (await again).setFiles({ name: 'export.zip', mimeType: 'application/zip', buffer: Buffer.from(exportZip) });
  await w.getByText('0 new rides added, 7 rides already here.').waitFor({ timeout: 60000 });

  // The planner knows what is ridden now, and offers favourites. The big area was left off above: choose it here.
  await w.getByRole('button', { name: 'Route planner →' }).click();
  await w.locator('ul.choose').getByLabel(/Imported hill/).check();
  await w.getByRole('button', { name: 'Use these areas' }).click();
  await w.getByText('Click the map to place the start.').first().waitFor({ timeout: 30000 });
  const summary = await w.locator('.step').first().innerText();
  const ridden = Number(summary.match(/(\d+)% ridden/)![1]);
  console.log('ridden in the area:', ridden, '%');
  assert.ok(ridden >= 2 && ridden < 50);
  await w.waitForTimeout(500);
  const pb2 = (await w.locator('.map').boundingBox())!;
  const at2 = await w.evaluate(([x, y]) => (window as any).__planMap.project([x, y]), Q(-200, -150));
  await w.mouse.click(pb2.x + at2.x, pb2.y + at2.y);
  await w.getByLabel('Distance', { exact: true }).fill('6');
  await w.getByLabel('Include my favourite trails').check();
  await w.getByRole('button', { name: 'Plan routes' }).click();
  await w.locator('.route-card').first().getByText('Favourites').waitFor({ timeout: 60000 });
  await w.getByRole('button', { name: '← Back to the map' }).click();

  // An excluded zone, kept in the config like on the desktop.
  await w.getByRole('button', { name: 'Add zone' }).click();
  const mb2 = (await w.locator('.map').boundingBox())!;
  await w.mouse.click(mb2.x + mb2.width / 2, mb2.y + mb2.height / 2);
  await w.getByText('Zone 1').waitFor();
  await w.getByRole('button', { name: 'Customize' }).click();
  const zoneDown = nextDownload();
  await w.getByRole('button', { name: 'Export config (.zip)' }).click();
  const withZone = unzipSync(new Uint8Array((await zoneDown).bytes));
  assert.match(strFromU8(withZone['zones/zones.geojson']!), /"Zone 1"/);
  assert.ok(!Object.keys(withZone).some((f) => /fit|ride/i.test(f)), 'rides are not in the config');

  // Rides are still there after closing the browser.
  await app.close();
  app = await launch();
  w = await app.firstWindow();
  watch();
  await w.getByText('7 rides on the map').waitFor({ timeout: 30000 });
  await w.getByText('Zone 1').waitFor();

  const bad = logs.filter((l) => !/Failed to load resource|could not be loaded|Expected value to be of type number/.test(l));
  if (bad.length) console.log('page errors:', bad);
  assert.equal(bad.length, 0, 'no page errors');
  console.log('Web E2E passed');
} finally {
  await app.close().catch(() => {});
  closeServers();
}
