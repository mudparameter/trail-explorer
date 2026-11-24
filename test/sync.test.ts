import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRide } from '../src/core/ride.ts';
import { Garmin, KeyRejected } from '../src/desktop/garmin.ts';
import { Store } from '../src/desktop/store.ts';
import { Sync } from '../src/desktop/sync.ts';
import { fakeGarmin, fit, KEY, zipOf, type FakeOpts } from './fake-garmin.ts';

const line: [number, number][] = Array.from({ length: 60 }, (_, i) => [-0.45 + i * 1e-4, 39.7]);
const good = () => zipOf('1_ACTIVITY.fit', fit(line));
const rides = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, body: good() }));

async function setup(opts: FakeOpts, fn: (x: any) => Promise<void>) {
  const f = await fakeGarmin(opts);
  const dir = mkdtempSync(join(tmpdir(), 'te-'));
  const store = new Store(join(dir, 'db'));
  let rebuilds = 0;
  const make = (key = KEY) => {
    const s: any = new Sync({ store, garmin: new Garmin(async () => key, f.base), ridesDir: join(dir, 'rides'), readRide, ridesChanged: () => rebuilds++, changed: () => {}, pause: 0, retryBase: 5 });
    s.go = async () => { s.start(); await s.running; };
    return s;
  };
  try { await fn({ f, store, make, dir, rebuilds: () => rebuilds }); } finally { f.close(); store.close(); }
}

test('imports every page', () => setup({ rides: rides(250) }, async ({ store, make, dir, rebuilds }) => {
  const s = make(); await s.go();
  assert.equal(s.state, 'idle');
  assert.equal(store.counts().done, 250);
  assert.equal(readdirSync(join(dir, 'rides')).length, 250);
  assert.equal(rebuilds(), 10);
  assert.equal(store.tracks().length, 250);
}));
test('a second sync downloads only new rides', () => setup({ rides: rides(5) }, async ({ f, store, make }) => {
  await make().go();
  f.opts.rides.push({ id: 5000, start: '2099-01-01', body: good() });
  await make().go();
  assert.equal(f.downloads.length, 6);
  assert.equal(store.counts().done, 6);
}));
test('virtual, indoor, broken and non-fit files', () => setup({ rides: [
  { id: 1, body: good() }, { id: 2, type: 'virtual_ride', body: good() }, { id: 3, body: zipOf('a.fit', fit([])) },
  { id: 4, body: Buffer.from('not a zip') }, { id: 5, body: zipOf('a.gpx', Buffer.from('<gpx/>')) },
] }, async ({ f, store, make }) => {
  const s = make(); await s.go();
  assert.equal(s.state, 'idle');
  assert.deepEqual(store.counts(), { waiting: 0, done: 1, 'no-gps': 1, failed: 1, unread: 1, same: 0, total: 4 });
  assert.ok(!f.downloads.includes('2'));
}));
test('rejected key', () => setup({ rides: rides(1), rejectKey: true }, async ({ make }) => {
  const s = make(); await s.go();
  assert.equal(s.state, 'key-rejected');
  assert.ok(!s.message.includes(KEY));
  await assert.rejects(new Garmin(async () => null, 'http://127.0.0.1:9').search(0, null), KeyRejected);
}));
test('expired token is replaced once', () => setup({ rides: rides(3) }, async ({ f, store, make }) => {
  const s = make();
  f.opts.revokeToken = true;
  await s.go();
  assert.equal(f.tokens, 2);
  assert.equal(store.counts().done, 3);
}));
test('key revoked halfway keeps what it has', () => setup({ rides: rides(30), delay: 2 }, async ({ f, store, make }) => {
  const s = make();
  const t = setInterval(() => { if (f.downloads.length > 5) f.opts.rejectKey = true; }, 1);
  await s.go(); clearInterval(t);
  assert.equal(s.state, 'key-rejected');
  assert.ok(store.counts().done >= 5);
  assert.ok(store.counts().waiting > 0);
}));
test('waits when Garmin is busy', () => setup({ rides: rides(3), busy: 3 }, async ({ store, make }) => {
  await make().go();
  assert.equal(store.counts().done, 3);
}));
test('closing halfway picks up where it stopped', () => setup({ rides: rides(20), delay: 5 }, async ({ f, store, make }) => {
  const s = make(); s.start();
  while (f.downloads.length < 5) await new Promise((r) => setTimeout(r, 2));
  await s.stop();
  const had = store.counts().done;
  assert.ok(had >= 4 && had < 20);
  f.opts.delay = 0;
  await make().go();
  assert.equal(store.counts().done, 20);
  assert.ok(f.downloads.length <= 21);
}));
test('no internet, then back', async () => {
  const f = await fakeGarmin({ rides: rides(2) });
  const port = Number(new URL(f.base).port); f.close();
  await setup({ rides: [] }, async ({ store, dir }) => {
    const s: any = new Sync({ store, garmin: new Garmin(async () => KEY, `http://127.0.0.1:${port}`), ridesDir: join(dir, 'r'), readRide, ridesChanged() {}, changed() {}, pause: 0, retryBase: 5 });
    s.start();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.state, 'offline');
    await s.stop();
  });
});
test('stops and says why when every download is refused, then recovers', () => setup({ rides: rides(30), refuse: true }, async ({ f, store, make }) => {
  const s = make(); await s.go();
  assert.equal(s.state, 'error');
  assert.match(s.message, /406/);
  assert.equal(f.downloads.length, 5);
  f.opts.refuse = false;
  await make().go();
  assert.equal(store.counts().done, 30);
}));
