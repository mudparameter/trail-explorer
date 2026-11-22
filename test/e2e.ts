// Drives the real app against a fake Garmin. Run: BBBIKE=folder SHOTS=folder node test/e2e.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright-core';
import electronPath from 'electron';
import { fakeGarmin, fit, KEY, zipOf } from './fake-garmin.ts';

const shots = process.env.SHOTS!;
const K = 111320, C = Math.cos((39.7 * Math.PI) / 180);
const P = (x: number, y: number): [number, number] => [-0.47 + x / (K * C), 39.7 + y / K];
let seed = 5;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
function path(fn: (t: number) => [number, number], n: number) {
  let ex = 0, ey = 0;
  return Array.from({ length: n }, (_, i) => {
    ex = ex * 0.95 + rnd() * 2; ey = ey * 0.95 + rnd() * 2;
    const [x, y] = fn(i / (n - 1));
    return P(x + ex, y + ey);
  });
}
const climb = (t: number): [number, number] => [t * 4000, 600 * Math.sin(t * 5)];
const end = climb(1);
const branch = (a: number) => (t: number): [number, number] => t < 0.5 ? climb(t * 2) : [end[0] + (t - 0.5) * 2 * 3000 * Math.cos(a), end[1] + (t - 0.5) * 2 * 3000 * Math.sin(a) + 200 * Math.sin(t * 20)];
const plan: [number, number][] = [[1.2, 50], [0.5, 14], [0, 6], [-0.6, 3], [-1.2, 1]];
let id = 100;
const rides = plan.flatMap(([a, n]) => Array.from({ length: n }, () => ({ id: id++, body: zipOf('a.fit', fit(path(branch(a), 1200))) })));
rides.push({ id: 9999, type: 'virtual_ride', body: zipOf('a.fit', fit(path(climb, 10))) } as any);

const f = await fakeGarmin({ rides, delay: 20 });
const data = mkdtempSync(join(tmpdir(), 'te-e2e-'));
const launch = () => _electron.launch({ executablePath: electronPath as unknown as string, args: ['.', '--use-mock-keychain'], env: { ...process.env, TRAIL_TEST_DATA: data, TRAIL_TEST_GARMIN: f.base } as any });
let app = await launch();
let w = await app.firstWindow();
const logs: string[] = [];
const watch = () => { w.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(m.text()); }); w.on('pageerror', (e) => logs.push('PAGE ' + e.message)); };
watch();
const shot = (n: string) => w.screenshot({ path: join(shots, `${n}.png`) });
const idle = () => w.waitForFunction(() => (window as any).__map?.loaded() && (window as any).__map.areTilesLoaded(), null, { timeout: 30000 }).catch(() => console.log('map not idle'));

// A2: asks for the key
await w.getByText('needs your Garmin personal API key').waitFor();
await shot('1-welcome');
await w.getByLabel('Garmin personal API key').fill('wrong-key-123');
await w.getByRole('button', { name: 'Save key' }).click();
await w.getByText('Garmin did not accept this key').waitFor();
await w.getByLabel('Garmin personal API key').fill(KEY);
await w.getByRole('button', { name: 'Save key' }).click();
await w.getByText(/of 74 rides/).waitFor();
await shot('2-importing');
await w.getByText('74 rides on the map').waitFor({ timeout: 90000 });
await w.waitForFunction(() => !document.body.innerText.includes('Drawing the heatmap'));
await w.getByRole('button', { name: 'Go to my rides' }).click();
await w.waitForTimeout(1500); await idle();
await shot('3-heatmap');
const seen = await w.evaluate(() => [...new Set((window as any).__map.queryRenderedFeatures({ layers: ['heat'] }).map((x: any) => x.properties.n))].sort((a: any, b: any) => a - b));
console.log('counts on map', seen);
assert.ok(seen.includes(1) && seen.some((n: any) => n >= 70));

// A5: other layers
for (const n of ['World topo', 'Spain topo']) {
  await w.getByRole('checkbox', { name: n }).check();
  await w.waitForTimeout(1500); await idle();
  await shot(`4-${n.replace(' ', '-')}`);
}
// A3: custom map, by drop path (the picker is a system dialog)
if (process.env.BBBIKE) {
  const file = join(process.env.BBBIKE, 'CraterLake.osm.pmtiles-shortbread.zip');
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, file);
  const t = Date.now();
  await w.getByRole('button', { name: 'Add map' }).click();
  await w.getByRole('button', { name: 'Remove' }).waitFor({ timeout: 60000 });
  console.log('custom map added in', Date.now() - t, 'ms');
  await w.waitForTimeout(1500); await idle();
  await shot('5-custom');
  await w.evaluate(() => (window as any).__map.jumpTo({ center: [-122.135, 42.91], zoom: 13.2 }));
  await w.waitForTimeout(1500); await idle();
  await shot('6-custom-close');
  await w.getByLabel('CraterLake opacity').fill('0.5');
  await w.waitForTimeout(800);
  // refused file
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, join(process.cwd(), 'package.json'));
  await w.getByRole('button', { name: 'Add map' }).click();
  await w.getByText('not a map the app can read').waitFor();
  await w.getByRole('button', { name: 'Close' }).click();
}
await w.evaluate(() => (window as any).__map.jumpTo({ center: [0, 30], zoom: 1.5 }));
await w.waitForTimeout(1200); await idle();
await shot('7-world');
assert.ok(await w.evaluate(() => (window as any).__map.queryRenderedFeatures({ layers: ['heat-dots'] }).length) > 0, 'rides visible from world view');
await w.getByRole('button', { name: 'Settings', exact: true }).click(); await shot('8-settings');
await w.getByRole('button', { name: 'Help', exact: true }).click(); await shot('9-help');
await w.getByRole('button', { name: 'Map', exact: true }).click();
await w.waitForTimeout(600);

// The window has no access to Node, and the key is not in plain text on disk.
assert.equal(await w.evaluate(() => typeof (globalThis as any).require + typeof (globalThis as any).process), 'undefinedundefined');
assert.ok(!readFileSync(join(data, 'key.bin')).includes(KEY));
assert.ok(!readFileSync(join(data, 'trail-explorer.db')).includes(KEY));
for (const p of ['trail://app/%2e%2e/main/main.cjs', 'trail://maps/..%2f..%2fkey.bin/0/0/0', 'trail://styles/..%2f..%2fpackage.json']) {
  const s = await w.evaluate((u) => fetch(u).then((r) => r.status + ':' + r.headers.get('content-type'), () => 'blocked'), p);
  console.log(p, s);
  assert.ok(!s.startsWith('200'));
}

// Reopen: no key prompt, same layers and position, no repeat downloads
const n = f.downloads.length;
await app.close();
const t0 = Date.now();
app = await launch(); w = await app.firstWindow(); watch();
await w.getByText('74 rides on the map').waitFor();
await w.waitForFunction(() => (window as any).__map?.getLayer('heat'));
console.log('reopened in', Date.now() - t0, 'ms');
assert.ok(Math.abs(await w.evaluate(() => (window as any).__map.getZoom()) - 1.5) < 0.01);
assert.ok(await w.getByRole('checkbox', { name: 'Spain topo' }).isChecked());
await w.waitForTimeout(1500);
assert.equal(f.downloads.length, n);

// Key stops working: map stays
f.opts.rejectKey = true;
await w.getByRole('button', { name: 'Sync now' }).click();
await w.getByText('Enter a new key').waitFor();
await shot('10-key-problem');
f.opts.rejectKey = false;
// Delete rides
await w.getByRole('button', { name: 'Settings', exact: true }).click();
await w.getByRole('button', { name: 'Delete all rides' }).click();
await w.getByRole('button', { name: 'Delete all rides' }).click();
await w.getByText('0 rides are stored').waitFor();
await app.close();
f.close();
console.log('console problems:', [...new Set(logs)].slice(0, 15));
console.log('E2E passed');
