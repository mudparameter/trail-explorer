import test from 'node:test';
import assert from 'node:assert/strict';
import { HeatmapBuilder, bandOf, type HeatLine } from '../src/core/heatmap.ts';
import { cleanTrack, metres, packTrack, unpackTrack, M_PER_DEG } from '../src/core/track.ts';

const LAT = 39.7, LON = -0.45, KX = M_PER_DEG * Math.cos((LAT * Math.PI) / 180);
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());

/** Ride through metre positions, with a slow-drifting GPS error of about `err` metres. */
function ride(path: [number, number][], err = 0): Float64Array[] {
  const out: number[] = [];
  let ex = gauss() * err, ey = gauss() * err;
  for (let i = 0; i + 1 < path.length; i++) {
    const [x1, y1] = path[i]!, [x2, y2] = path[i + 1]!;
    const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / 6));
    for (let k = 0; k < n; k++) {
      ex = ex * 0.97 + gauss() * err * 0.24; ey = ey * 0.97 + gauss() * err * 0.24;
      out.push(LON + (x1 + ((x2 - x1) * k) / n + ex) / KX, LAT + (y1 + ((y2 - y1) * k) / n + ey) / M_PER_DEG);
    }
  }
  const [x, y] = path.at(-1)!;
  out.push(LON + (x + ex) / KX, LAT + (y + ey) / M_PER_DEG);
  return [Float64Array.from(out)];
}
const len = (l: HeatLine) => l.coords.slice(1).reduce((s, c, i) => s + metres(...l.coords[i]!, ...c), 0);
const build = (rides: Float64Array[][]) => {
  const b = new HeatmapBuilder();
  for (const r of rides) b.addRide(r);
  return b.finish().lines;
};
const total = (ls: HeatLine[]) => ls.reduce((s, l) => s + len(l), 0);
/** Share of drawn length whose count passes the check. */
const share = (ls: HeatLine[], f: (n: number) => boolean) => total(ls.filter((l) => f(l.n))) / total(ls);
const near = (v: number, want: number, tol: number, msg = '') => assert.ok(Math.abs(v - want) <= tol, `${msg} got ${v}, want ${want} ± ${tol}`);

const wavy: [number, number][] = Array.from({ length: 101 }, (_, i) => [i * 20, 120 * Math.sin(i / 8)]);
const wavyLen = wavy.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - wavy[i]![0], p[1] - wavy[i]![1]), 0);

test('one pass', () => {
  const ls = build([ride(wavy)]);
  near(total(ls), wavyLen, wavyLen * 0.03);
  assert.equal(share(ls, (n) => n === 1), 1);
});
test('ten passes with GPS drift make one line of ten', () => {
  seed = 7;
  const ls = build(Array.from({ length: 10 }, () => ride(wavy, 4)));
  near(total(ls), wavyLen, wavyLen * 0.12, 'length');
  assert.ok(share(ls, (n) => n >= 9 && n <= 11) > 0.85, JSON.stringify(ls.map((l) => [l.n, Math.round(len(l))])));
});
test('forty passes stay one line', () => {
  seed = 11;
  const ls = build(Array.from({ length: 40 }, () => ride(wavy, 4)));
  near(total(ls), wavyLen, wavyLen * 0.2, 'length');
  assert.ok(share(ls, (n) => n >= 36 && n <= 44) > 0.8, JSON.stringify(ls.map((l) => [l.n, Math.round(len(l))])));
});
test('five laps in one ride count as five', () => {
  seed = 3;
  const loop: [number, number][] = [];
  for (let i = 0; i <= 5 * 60; i++) loop.push([150 * Math.cos((i / 60) * 2 * Math.PI), 150 * Math.sin((i / 60) * 2 * Math.PI)]);
  const ls = build([ride(loop, 2)]);
  near(total(ls), 2 * Math.PI * 150, 150, 'length');
  assert.ok(share(ls, (n) => n === 5) > 0.85, JSON.stringify(ls.map((l) => [l.n, Math.round(len(l))])));
});
test('out and back counts as two', () => {
  seed = 5;
  const ls = build([ride([[0, 0], [1000, 0], [0, 0]], 1)]);
  near(total(ls), 1000, 120, 'length');
  assert.ok(share(ls, (n) => n === 2) > 0.85, JSON.stringify(ls.map((l) => [l.n, Math.round(len(l))])));
});
test('a rest stop does not add passes', () => {
  seed = 9;
  const pts = [];
  let t = 0;
  for (let x = 0; x <= 500; x += 5) pts.push({ x, y: 0, t: t++ });
  for (let i = 0; i < 600; i++) pts.push({ x: 500 + gauss() * 1.5, y: gauss() * 1.5, t: t++ });
  for (let x = 505; x <= 1000; x += 5) pts.push({ x, y: 0, t: t++ });
  const tr = cleanTrack(pts.map((p) => ({ lon: LON + p.x / KX, lat: LAT + p.y / M_PER_DEG, t: p.t })));
  const ls = build([tr]);
  assert.ok(share(ls, (n) => n === 1) > 0.95, JSON.stringify(ls.map((l) => [l.n, Math.round(len(l))])));
});
test('trails 40 m apart stay separate', () => {
  const ls = build([ride([[0, 0], [1000, 0]]), ride([[0, 40], [1000, 40]])]);
  near(total(ls), 2000, 60);
  assert.equal(share(ls, (n) => n === 1), 1);
});
test('crossing trails do not add to each other', () => {
  const ls = build([ride([[0, 0], [1000, 0]]), ride([[500, -500], [500, 500]])]);
  assert.equal(share(ls, (n) => n === 1), 1);
});
test('a shared climb is hotter than the side trail', () => {
  seed = 13;
  const a: [number, number][] = [[0, 0], [1000, 0], [1500, 500]];
  const b: [number, number][] = [[0, 0], [1000, 0], [1500, -500]];
  const ls = build([ride(a, 2), ride(a, 2), ride(a, 2), ride(b, 2)]);
  near(total(ls.filter((l) => l.n === 4)), 1000, 120, 'shared');
  near(total(ls.filter((l) => l.n === 3)), 707, 120, 'a only');
  near(total(ls.filter((l) => l.n === 1)), 707, 120, 'b only');
});
test('switchbacks 20 m apart stay separate', () => {
  const z: [number, number][] = [];
  for (let k = 0; k < 6; k++) z.push(k % 2 ? [200, k * 20] : [0, k * 20], k % 2 ? [0, k * 20] : [200, k * 20]);
  const ls = build([ride(z)]);
  assert.ok(share(ls, (n) => n === 1) > 0.9, JSON.stringify(ls.map((l) => [l.n, Math.round(len(l))])));
});
test('cleaning drops jumps and splits gaps', () => {
  const p = (x: number, t: number) => ({ lon: LON + x / KX, lat: LAT, t });
  const tr = cleanTrack([p(0, 0), p(10, 1), p(5000, 2), p(20, 3), p(30, 4), p(900, 600), p(910, 601)]);
  assert.equal(tr.length, 2);
  assert.deepEqual(unpackTrack(packTrack(tr)), tr);
});
test('bands', () => assert.deepEqual([1, 2, 3, 4, 7, 8, 15, 16, 39, 40, 99].map(bandOf), [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]));
test('speed', () => {
  seed = 21;
  const rides = Array.from({ length: 200 }, (_, i) => ride(Array.from({ length: 400 }, (_, k) => [k * 100, 3000 * Math.sin(k / 30 + (i % 10))]), 4));
  const t = performance.now();
  build(rides);
  console.log(`200 rides of 40+ km: ${Math.round(performance.now() - t)} ms`);
});
