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
const f = await fakeGarmin({ rides: [2, 4, 6, 8, 4, 4, 4].map((j, i) => ({ id: 500 + i, start: `2025-0${i + 1}-01 08:00:00`, body: zipOf('a.fit', fit(ride(j), `2025-0${i + 1}-01T08:00:00Z`)) })) });

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
  await w.getByText('7 rides on the map').waitFor({ timeout: 60000 });

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
  // The profile fills its panel, and the mouse lines up with it: the ends of the line are the ends of the route.
  const panel = (await w.locator('.profile-panel').boundingBox())!;
  assert.ok(svg.width > panel.width - 40, `profile ${svg.width} px wide in a ${panel.width} px panel`);
  const routeKm = Number(card.match(/Distance\s*([\d.]+) km/)![1]);
  const kmAt = async (x: number) => {
    await w.mouse.move(x, svg.y + svg.height / 2);
    return Number((await w.locator('.profile figcaption').innerText()).match(/^([\d.]+) km/)![1]);
  };
  const atStart = await kmAt(svg.x + 46 + 1), atEnd = await kmAt(svg.x + svg.width - 50 - 1);
  const atMid = await kmAt(svg.x + 46 + (svg.width - 96) / 2);
  console.log('profile under the mouse:', atStart, atMid, atEnd, 'of', routeKm, 'km');
  assert.ok(atStart < 0.05, `left end ${atStart}`);
  assert.ok(Math.abs(atEnd - routeKm) < 0.1, `right end ${atEnd} of ${routeKm}`);
  assert.ok(Math.abs(atMid - routeKm / 2) < 0.1, `middle ${atMid} of ${routeKm}`);
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

  // A limit on descents: every route keeps to it, or the planner says none can.
  const steepest = async () => (await w.locator('.route-card').allInnerTexts()).map((t) => Number(t.match(/Steepest\s*↑ \d+% ↓ (\d+)%/)![1]));
  const before = await steepest();
  console.log('steepest descents, no limit:', before.join(' '));
  const limit = Math.max(2, Math.min(...before) - 1);
  await w.locator('section.step', { hasText: 'Your ride' }).getByRole('button', { name: 'Change' }).click();
  await w.getByLabel('Steepest descent').fill(String(limit));
  await w.getByRole('button', { name: 'Plan routes' }).click();
  await Promise.race([w.locator('.route-card').first().waitFor({ timeout: 30000 }), w.getByText(/No route from there keeps descents/).waitFor({ timeout: 30000 })]);
  const after = await w.locator('.route-card').count() ? await steepest() : [];
  console.log(`steepest descents, limit ${limit}%:`, after.join(' ') || 'none possible');
  assert.ok(after.every((d) => d <= limit), `all within ${limit}%: ${after}`);
  await shot('2b-descent-limit');

  // And on climbs: the same, the other way.
  const steepestUp = async () => (await w.locator('.route-card').allInnerTexts()).map((t) => Number(t.match(/Steepest\s*↑ (\d+)%/)![1]));
  await w.locator('section.step', { hasText: 'Your ride' }).getByRole('button', { name: 'Change' }).click();
  await w.getByLabel('Steepest descent').fill('');
  await w.getByLabel('Steepest climb').fill(String(limit));
  await w.getByRole('button', { name: 'Plan routes' }).click();
  await Promise.race([w.locator('.route-card').first().waitFor({ timeout: 30000 }), w.getByText(/No route from there keeps climbs/).waitFor({ timeout: 30000 })]);
  const ups = await w.locator('.route-card').count() ? await steepestUp() : [];
  console.log(`steepest climbs, limit ${limit}%:`, ups.join(' ') || 'none possible');
  assert.ok(ups.every((d) => d <= limit), `all climbs within ${limit}%: ${ups}`);
  await w.locator('section.step', { hasText: 'Your ride' }).getByRole('button', { name: 'Change' }).click();
  await w.getByLabel('Steepest climb').fill('');

  // A new set: other routes from the same request.
  const ids = () => w.locator('.route-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-route')!));
  await w.getByRole('button', { name: 'Plan routes' }).click();
  await w.locator('.route-card').first().waitFor({ timeout: 30000 });
  const first = await ids();
  await w.getByRole('button', { name: 'Generate new routes' }).click();
  await w.waitForFunction((was) => { const now = [...document.querySelectorAll('.route-card')].map((e) => e.getAttribute('data-route')); return now.length > 0 && now.every((id) => !was.includes(id!)); }, first, { timeout: 30000 });
  const second = await ids();
  console.log('new routes:', first.join(' '), '→', second.join(' '));

  // Ridden paths: highlighted, darkened or hidden on the planner's map.
  const riddenPaint = () => w.evaluate(() => { const m = (window as any).__planMap; return m.getLayer('net-ridden') ? m.getPaintProperty('net-ridden', 'line-color') : null; });
  assert.equal(await riddenPaint(), '#2563eb');
  await w.getByLabel("Paths you've ridden").selectOption('dark');
  await w.waitForFunction(() => (window as any).__planMap.getLayer('net-ridden') && (window as any).__planMap.getPaintProperty('net-ridden', 'line-color') === '#27272a');
  await w.waitForTimeout(500);
  await shot('2c-ridden-dark');
  await w.getByLabel("Paths you've ridden").selectOption('hide');
  await w.waitForFunction(() => !(window as any).__planMap.getLayer('net-ridden'));
  // Hidden as ridden, they still show as paths: the dashed lines now include them.
  const pathFilter = () => w.evaluate(() => JSON.stringify((window as any).__planMap.getFilter('net-line')));
  assert.doesNotMatch(await pathFilter(), /ridden/);
  await w.waitForTimeout(500);
  await shot('2c-ridden-hidden');
  // Heatmap: ridden paths in the heatmap's colours by times ridden, with its outline and legend.
  await w.getByLabel("Paths you've ridden").selectOption('heatmap');
  await w.waitForFunction(() => !!(window as any).__planMap.getLayer('net-ridden-outline'));
  assert.match(JSON.stringify(await w.evaluate(() => (window as any).__planMap.getPaintProperty('net-ridden', 'line-color'))), /"step",\["get","passes"\]/);
  const passes = await w.evaluate(() => (window as any).__planMap.getStyle().sources.net.data.features.map((f: any) => f.properties.passes));
  assert.ok(Math.max(...passes) >= 4, `row 4 ridden 4 times: ${Math.max(...passes)}`);
  await w.locator('.plan-key .legend').getByText('4 to 7').waitFor();
  await w.waitForTimeout(500);
  await shot('2c-ridden-heatmap');
  await w.getByLabel("Paths you've ridden").selectOption('show');
  await w.waitForFunction(() => !!(window as any).__planMap.getLayer('net-ridden'));
  assert.match(await pathFilter(), /ridden/);

  // Favourites: row 4, ridden four times, is taken in.
  await w.locator('section.step', { hasText: 'Your ride' }).getByRole('button', { name: 'Change' }).click();
  await w.getByLabel('Include my favourite trails').check();
  await w.getByRole('button', { name: 'Plan routes' }).click();
  await w.locator('.route-card').first().getByText('Favourites').waitFor({ timeout: 30000 });
  const favs = (await w.locator('.route-card').allInnerTexts()).map((t) => t.match(/Favourites\s*([\d.]+) km/)?.[1] ?? '0');
  console.log('favourites per route, km:', favs.join(' '));
  assert.ok(favs.filter((x) => Number(x) > 0).length >= 2);
  await shot('2e-favourites');

  // Magic: only distance and difficulty count. A climbing wish of 9,000 m is ignored.
  await w.locator('section.step', { hasText: 'Your ride' }).getByRole('button', { name: 'Change' }).click();
  assert.ok(await w.getByRole('button', { name: '✨ Magic routes' }).isDisabled(), 'needs a difficulty');
  await w.getByLabel('Climbing', { exact: true }).fill('9000');
  await w.getByLabel('Hard', { exact: true }).check();
  await w.getByLabel('Magic distance tolerance').fill('2');
  await w.getByRole('button', { name: '✨ Magic routes' }).click();
  await w.locator('.route-card').first().waitFor({ timeout: 60000 });
  const magicCards = await w.locator('.route-card').allInnerTexts();
  const facts = magicCards.map((t) => `${t.match(/Distance\s*([\d.]+) km/)![1]} km ${t.match(/Easy|Moderate|Hard|Very hard/)![0]}`);
  console.log('magic, 6 ± 2 km, hard:', facts.join(' | '));
  const kmOf = (t: string) => Number(t.match(/Distance\s*([\d.]+) km/)![1]);
  const fits = magicCards.filter((t) => Math.abs(kmOf(t) - 6) <= 2.05 && /Hard/.test(t.split('\n').slice(0, 3).join(' ')));
  if (fits.length < magicCards.length) await w.getByText(/Closest that could be found/).waitFor();
  assert.ok(magicCards.every((t) => kmOf(t) < 20), 'the climbing wish was ignored');
  // Favourites are still ticked, and magic takes them in.
  const magicFavs = magicCards.map((t) => Number(t.match(/Favourites\s*([\d.]+) km/)?.[1] ?? 0));
  console.log('magic favourites per route, km:', magicFavs.join(' '));
  assert.ok(magicFavs.filter((x) => x > 0).length >= 2, 'magic routes take in favourites');
  await shot('2d-magic');
  const magicIds = await ids();
  await w.getByRole('button', { name: 'Generate new routes' }).click();
  await w.waitForFunction((was) => { const now = [...document.querySelectorAll('.route-card')].map((e) => e.getAttribute('data-route')); return now.length > 0 && now.every((id) => !was.includes(id!)); }, magicIds, { timeout: 60000 })
    .catch(async () => { await w.getByText(/No other routes from there/).waitFor({ timeout: 1000 }); console.log('magic: no other routes'); });
  console.log('magic, new set:', (await w.locator('.route-card').allInnerTexts()).map((t) => `${kmOf(t)} km`).join(' | '));
  await w.locator('section.step', { hasText: 'Your ride' }).getByRole('button', { name: 'Change' }).click();
  await w.getByLabel('Climbing', { exact: true }).fill('');
  await w.getByLabel('Any', { exact: true }).check();
  await w.getByLabel('Include my favourite trails').uncheck();

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
