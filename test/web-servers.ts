// The servers the website tests use: fake Overpass and elevation servers, as in
// e2e-planner.ts, and a host site with its own page and styles that serves the
// build (out/web) under /trail/, as a page on another site would use it.
// `launch` opens it in Electron's Chromium as a plain browser window.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { _electron } from 'playwright-core';
import electronPath from 'electron';

export const K = 111320, C = Math.cos((39.7 * Math.PI) / 180);
export const MID: [number, number] = [-0.45, 39.7];
export const Q = (x: number, y: number): [number, number] => [MID[0] + x / (K * C), MID[1] + y / K];
const CORS = { 'Access-Control-Allow-Origin': '*' };

// A grid of paths 150 m apart, 3 km across, as in e2e-planner.ts.
export const N = 21, GAP = 150, HALF = ((N - 1) * GAP) / 2;
const nid = (i: number, j: number) => 1000 + i * 100 + j;
const WORLD = [
  ...Array.from({ length: N }, (_, j) => ({ id: 1 + j, tags: { highway: j === 10 ? 'unclassified' : 'path', name: `Row ${j}` }, nodes: Array.from({ length: N }, (_, i) => nid(i, j)), pts: Array.from({ length: N }, (_, i) => Q(i * GAP - HALF, j * GAP - HALF)) })),
  ...Array.from({ length: N }, (_, i) => ({ id: 100 + i, tags: { highway: i % 4 === 0 ? 'track' : 'path' }, nodes: Array.from({ length: N }, (_, j) => nid(i, j)), pts: Array.from({ length: N }, (_, j) => Q(i * GAP - HALF, j * GAP - HALF)) })),
];
export const overpass = { calls: 0 };
const ops = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    overpass.calls++;
    const q = new URLSearchParams(body).get('data') ?? '';
    const boxes = [...q.matchAll(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/g)].map((m) => m.slice(1).map(Number));
    const hit = (pts: [number, number][]) => boxes.some(([s, w, n, e]) => pts.some(([x, y]) => x >= w! && x <= e! && y >= s! && y <= n!));
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS }).end(JSON.stringify({
      elements: WORLD.filter((wy) => hit(wy.pts)).map((wy) => ({ type: 'way', id: wy.id, tags: wy.tags, nodes: wy.nodes, geometry: wy.pts.map(([lon, lat]) => ({ lon, lat })) })),
    }));
  });
});
await new Promise<void>((ok) => ops.listen(0, '127.0.0.1', ok));

// Fake elevation: a hill in the middle, 120 m high.
const height = (lon: number, lat: number) => {
  const x = (lon - MID[0]) * K * C, y = (lat - MID[1]) * K;
  return 400 + 120 * Math.exp(-(x * x + y * y) / (2 * 700 ** 2));
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
export const terrain = { tiles: 0 };
const tsrv = createServer((req, res) => {
  const m = req.url!.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (!m) return res.writeHead(404, CORS).end();
  terrain.tiles++;
  const [z, tx, ty] = m.slice(1).map(Number) as [number, number, number];
  const n = 2 ** z;
  res.writeHead(200, { 'Content-Type': 'image/png', ...CORS }).end(png(256, 256, (px, py) => {
    const lon = ((tx + (px + 0.5) / 256) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + (py + 0.5) / 256)) / n))) * 180) / Math.PI;
    const v = height(lon, lat) + 32768;
    return [Math.floor(v / 256), Math.floor(v) % 256, Math.floor((v % 1) * 256)];
  }));
});
await new Promise<void>((ok) => tsrv.listen(0, '127.0.0.1', ok));

// The host site: its own page and styles, with the build under /trail/.
const web = resolve('out/web');
assert.ok(existsSync(join(web, 'trail-explorer.js')), 'run npm run build:web first');
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.pbf': 'application/x-protobuf', '.html': 'text/html', '.css': 'text/css' };
const host = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  if (url.pathname === '/') {
    return res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><html><head><meta charset="utf-8"><title>Host site</title>
<style>
  body { margin: 0; font: 20px Georgia, serif; color: #503; background: #fec; }
  header { height: 48px; padding: 8px; background: #333; color: #fff; }
  button { background: hotpink !important; font-size: 30px; }
  trail-explorer { height: calc(100vh - 64px); }
</style>
<script>window.__trailTest = ${JSON.stringify({ overpass: [`http://127.0.0.1:${(ops.address() as any).port}/api/interpreter`], terrain: `http://127.0.0.1:${(tsrv.address() as any).port}` })};</script>
<script type="module" src="/trail/trail-explorer.js"></script>
</head><body><header>A host site <button id="host-button">Host button</button></header><trail-explorer></trail-explorer></body></html>`);
  }
  if (!url.pathname.startsWith('/trail/')) return res.writeHead(404).end();
  const file = normalize(join(web, decodeURIComponent(url.pathname.slice('/trail/'.length))));
  if (!file.startsWith(web) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise<void>((ok) => host.listen(0, '127.0.0.1', ok));
export const site = `http://127.0.0.1:${(host.address() as any).port}/`;

/** Opens the host site in a browser window that keeps its storage in `data`, at `size` ("390x844") if given. */
export const launch = (data: string, size?: string) => _electron.launch({
  executablePath: electronPath as unknown as string, args: [resolve('test/web-shell.cjs')],
  env: { ...process.env, WEB_TEST_DATA: data, WEB_TEST_URL: site, ...(size ? { WEB_TEST_SIZE: size } : {}) } as any,
});
export const closeServers = () => {
  ops.close();
  tsrv.close();
  host.close();
};
/** A new empty folder for a browser's storage. */
export const browserData = () => mkdtempSync(join(tmpdir(), 'te-web-'));
