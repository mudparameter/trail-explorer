// Drives the route planner in the real app, against a fake Garmin, a fake
// Overpass with a grid of trails, and fake elevation tiles.
// Run: SHOTS=folder node test/e2e-planner.ts
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { _electron } from 'playwright-core';
import electronPath from 'electron';
import { fakeGarmin, fit, KEY, zipOf } from './fake-garmin.ts';

const shots = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), 'te-shots-'));
const K = 111320, C = Math.cos((39.7 * Math.PI) / 180);
const MID: [number, number] = [-0.45, 39.7];
const Q = (x: number, y: number): [number, number] => [MID[0] + x / (K * C), MID[1] + y / K];

// A grid of paths 150 m apart, 3 km across, sharing nodes where they cross. The middle row is a road.
const N = 21, GAP = 150, HALF = ((N - 1) * GAP) / 2;
const nid = (i: number, j: number) => 1000 + i * 100 + j;
const WORLD = [
  ...Array.from({ length: N }, (_, j) => ({ id: 1 + j, tags: { highway: j === 10 ? 'unclassified' : 'path', name: `Row ${j}` }, nodes: Array.from({ length: N }, (_, i) => nid(i, j)), pts: Array.from({ length: N }, (_, i) => Q(i * GAP - HALF, j * GAP - HALF)) })),
  ...Array.from({ length: N }, (_, i) => ({ id: 100 + i, tags: { highway: i % 4 === 0 ? 'track' : 'path' }, nodes: Array.from({ length: N }, (_, j) => nid(i, j)), pts: Array.from({ length: N }, (_, j) => Q(i * GAP - HALF, j * GAP - HALF)) })),
];
const ops = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const q = new URLSearchParams(body).get('data') ?? '';
    const boxes = [...q.matchAll(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/g)].map((m) => m.slice(1).map(Number));
    const hit = (pts: [number, number][]) => boxes.some(([s, w, n, e]) => pts.some(([x, y]) => x >= w! && x <= e! && y >= s! && y <= n!));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      elements: WORLD.filter((wy) => hit(wy.pts)).map((wy) => ({ type: 'way', id: wy.id, tags: wy.tags, nodes: wy.nodes, geometry: wy.pts.map(([lon, lat]) => ({ lon, lat })) })),
    }));
  });
});
await new Promise<void>((ok) => ops.listen(0, '127.0.0.1', ok));

// Fake elevation: a hill in the middle, 120 m high, and a steep bank in the north.
const height = (lon: number, lat: number) => {
  const x = (lon - MID[0]) * K * C, y = (lat - MID[1]) * K;
  return 400 + 120 * Math.exp(-(x * x + y * y) / (2 * 700 ** 2)) + (y > 900 ? Math.min(60, (y - 900) * 0.3) : 0);
};
function png(w: number, h: number, rgb: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const terrain = { tiles: 0 };
const tsrv = createServer((req, res) => {
  const m = req.url!.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (!m) return res.writeHead(404).end();
  terrain.tiles++;
  const [z, tx, ty] = m.slice(1).map(Number) as [number, number, number];
  const n = 2 ** z;
  res.writeHead(200, { 'Content-Type': 'image/png' }).end(png(256, 256, (px, py) => {
    const lon = ((tx + (px + 0.5) / 256) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + (py + 0.5) / 256)) / n))) * 180) / Math.PI;
    const v = height(lon, lat) + 32768;
    return [Math.floor(v / 256), Math.floor(v) % 256, Math.floor((v % 1) * 256)];
  }));
});
await new Promise<void>((ok) => tsrv.listen(0, '127.0.0.1', ok));

// Rides along the western half of the southern rows.
const ride = (j: number) => Array.from({ length: 200 }, (_, i) => Q(-HALF + (i / 199) * HALF, j * GAP - HALF));
const f = await fakeGarmin({ rides: [2, 4, 6, 8].map((j, i) => ({ id: 500 + i, start: `2025-0${i + 1}-01 08:00:00`, body: zipOf('a.fit', fit(ride(j), `2025-0${i + 1}-01T08:00:00Z`)) })) });

const data = mkdtempSync(join(tmpdir(), 'te-plan-'));
const app = await _electron.launch({
  executablePath: electronPath as unknown as string, args: ['.', '--use-mock-keychain'],
  env: { ...process.env, TRAIL_TEST_DATA: data, TRAIL_TEST_GARMIN: f.base, TRAIL_TEST_OVERPASS: `http://127.0.0.1:${(ops.address() as any).port}/api/interpreter`, TRAIL_TEST_TERRAIN: `http://127.0.0.1:${(tsrv.address() as any).port}` } as any,
});
const w = await app.firstWindow();
const logs: string[] = [];
w.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
w.on('pageerror', (e) => logs.push('PAGE ' + e.message));
const shot = (n: string) => w.screenshot({ path: join(shots, `p${n}.png`) });
const cfg = (f: string) => join(data, 'config', f);
const waitFor = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting: ${what}`);
};

try {
  await w.getByLabel('Garmin personal API key').fill(KEY);
  await w.getByRole('button', { name: 'Save key' }).click();
  await w.getByText('4 rides on the map').waitFor({ timeout: 60000 });

  // Draw an area over the grid.
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

  // 1. Areas: the planner is its own mode.
  await w.getByRole('button', { name: 'Route planner →' }).click();
  await w.locator('.mode-bar').getByText('Route planner').waitFor();
  assert.equal(await w.locator('.side nav').count(), 0, 'the main sidebar is gone');
  await shot('1-areas');
  await w.getByRole('button', { name: 'Use these areas' }).click();
  await w.getByText('Click the map to place the start.').first().waitFor({ timeout: 30000 });
  assert.ok(terrain.tiles > 0, 'elevation downloaded');
  const summary = await w.locator('.step').first().innerText();
  console.log(summary.replace(/\s+/g, ' '));
  assert.match(summary, /km of paths, \d+% ridden/);
  const ridden = Number(summary.match(/(\d+)% ridden/)![1]);
  assert.ok(ridden >= 2 && ridden < 50, 'some of it is ridden');

  // 2. Start: a click inside the area.
  await w.waitForTimeout(500);
  const pb = (await w.locator('.map').boundingBox())!;
  const at = await w.evaluate(([x, y]) => (window as any).__planMap.project([x, y]), Q(-200, -150));
  await w.mouse.click(pb.x + at.x, pb.y + at.y);

  // 3. The ride.
  await w.getByLabel('Distance', { exact: true }).fill('6');
  await w.getByRole('button', { name: 'Plan routes' }).click();

  // 4. Routes: three to five, rated, in both units.
  await w.locator('.route-card').nth(2).waitFor({ timeout: 30000 });
  const cards = await w.locator('.route-card').count();
  assert.ok(cards >= 3 && cards <= 5, `${cards} routes`);
  console.log('new trail per route:', (await w.locator('.route-card').allInnerTexts()).map((t) => t.match(/New trail[^,]*, (\d+%)/)?.[1]).join(' '));
  const card = await w.locator('.route-card').first().innerText();
  console.log(card.replace(/\s+/g, ' '));
  assert.match(card, /\d+\.\d km \(\d+\.\d mi\)/);
  assert.match(card, /↑ \d+ m \([\d,]+ ft\)/);
  assert.match(card, /Easy|Moderate|Hard|Very hard/);
  assert.match(card, /New trail/);
  await w.locator('.route-card').first().getByRole('button', { name: 'Elevation profile' }).click();
  await w.getByRole('img', { name: 'Elevation profile' }).waitFor();
  const svg = (await w.getByRole('img', { name: 'Elevation profile' }).boundingBox())!;
  await w.mouse.move(svg.x + svg.width / 2, svg.y + svg.height / 2);
  await w.locator('.profile figcaption').getByText(/km \(.* mi\) · .* m \(.* ft\)/).waitFor();
  await shot('2-routes');

  // Save one.
  await w.locator('.route-card').first().getByRole('button', { name: 'Save…' }).click();
  await w.getByLabel('Route name').fill('Morning loop');
  await w.locator('.route-card').first().getByRole('button', { name: 'Save', exact: true }).click();
  await w.getByText('Saved as “Morning loop”.').waitFor();
  const saved = () => JSON.parse(readFileSync(cfg('routes.json'), 'utf8')).routes as any[];
  assert.equal(saved().length, 1);
  const id = saved()[0].id;
  // The same numbers as on the card.
  assert.ok(card.includes(`↑ ${saved()[0].gain.toLocaleString('en-US')} m`), `card and saved climbing match: ${saved()[0].gain}`);
  assert.ok(existsSync(cfg(`routes/${id}.gpx`)));
  assert.match(readFileSync(cfg(`routes/${id}.gpx`), 'utf8'), /<name>Morning loop<\/name>[\s\S]*<ele>/);
  // A second one, to sort.
  await w.locator('.route-card').nth(1).getByRole('button', { name: 'Save…' }).click();
  await w.locator('.route-card').nth(1).getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(() => saved().length === 2, 'second route saved');

  // The saved routes table: sort, rename, view, download, delete.
  await w.getByRole('button', { name: 'Saved routes' }).click();
  await w.getByRole('heading', { name: 'Saved routes' }).waitFor();
  const names = () => w.locator('table.routes tbody td.name').allInnerTexts();
  await w.getByRole('button', { name: /^Distance/ }).click();
  const dists = async () => (await w.locator('table.routes tbody tr').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-route')))).map((rid) => saved().find((r) => r.id === rid).distance);
  const down = await dists();
  assert.ok(down[0] >= down[1], `longest first: ${down}`);
  assert.equal(await w.getByRole('columnheader', { name: /Distance/ }).getAttribute('aria-sort'), 'descending');
  await w.getByRole('button', { name: /^Distance/ }).click();
  const up = await dists();
  assert.ok(up[0] <= up[1], `then shortest first: ${up}`);
  assert.equal(await w.getByRole('columnheader', { name: /Distance/ }).getAttribute('aria-sort'), 'ascending');
  assert.equal((await names()).length, 2);
  const row = w.locator(`tr[data-route="${id}"]`);
  await row.getByRole('button', { name: 'Rename' }).click();
  await row.getByLabel('Route name').fill('Evening loop');
  await row.getByRole('button', { name: 'Save' }).click();
  await waitFor(() => saved().find((r) => r.id === id)?.name === 'Evening loop', 'renamed');
  assert.match(readFileSync(cfg(`routes/${id}.gpx`), 'utf8'), /<name>Evening loop<\/name>/);
  await row.getByRole('button', { name: 'Evening loop' }).click();
  await w.locator('.route-view').getByRole('img', { name: 'Elevation profile' }).waitFor();
  await w.waitForTimeout(800);
  await shot('3-saved');
  const out = join(mkdtempSync(join(tmpdir(), 'te-gpx-')), 'route.gpx');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as any; }, out);
  await row.getByRole('button', { name: 'Download .gpx' }).click();
  await waitFor(() => existsSync(out), 'gpx downloaded');
  assert.match(readFileSync(out, 'utf8'), /<trkpt lat=/);
  await row.getByRole('button', { name: 'Delete' }).click();
  await row.getByRole('button', { name: 'Delete' }).click();
  await waitFor(() => saved().length === 1 && !existsSync(cfg(`routes/${id}.gpx`)), 'deleted');

  // Back and forth between the modes.
  await w.getByRole('button', { name: 'Plan a route' }).click();
  await w.locator('.mode-bar').waitFor();
  await w.getByRole('button', { name: '← Back to the map' }).click();
  await w.locator('.side nav').waitFor();
  assert.deepEqual(logs.filter((l) => !/Failed to load resource|shield/.test(l)), []);
  console.log('Planner E2E passed');
} finally {
  await app.close();
  f.close();
  ops.close();
  tsrv.close();
}
