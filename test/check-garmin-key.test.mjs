import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { zipSync } from 'fflate';
import { FitBaseType, FitEncoder } from 'fit-file-parser';
import { cyclingKeys, dayOf, inspectZip, runTest, spread } from '../scripts/check-garmin-key.mjs';

const KEY = 'made-up-key-SECRET';
const jwt = `x.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 86400 })).toString('base64url')}.y`;
const semi = (deg) => Math.round((deg * 2 ** 31) / 180);

function fit(points) {
  const e = new FitEncoder();
  const t0 = FitEncoder.toFitTimestamp(new Date('2025-05-01T08:00:00Z'));
  e.writeMessage(0, [
    { number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 },
    { number: 4, size: 4, baseType: FitBaseType.Uint32, value: t0 },
  ]);
  for (let i = 0; i < points; i++) {
    e.writeMessage(20, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: t0 + i * 2 },
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: semi(10 + i * 1e-4) },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: semi(20) },
    ], 1);
  }
  return e.close();
}
const zip = (name, data) => Buffer.from(zipSync({ [name]: data }));

async function withServer(opts, fn) {
  const total = opts.total ?? 250;
  const rides = Array.from({ length: total }, (_, i) => ({
    activityId: 900000000 + i,
    activityName: 'Private ride name',
    startLatitude: 12.3456,
    startTimeGMT: `${2026 - Math.floor(i / 100)}-03-01 10:00:00`,
    activityType: { typeKey: i % 2 ? 'mountain_biking' : 'cycling' },
  }));
  const seen = { throttles: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (c, b, h) => { res.writeHead(c, h); res.end(b); };
    if (u.pathname.endsWith('/token')) {
      if (opts.redirect) return send(302, '', { location: opts.redirect });
      return req.headers.authorization === `ApiKey ${KEY}` && req.method === 'POST' ? send(200, jwt) : send(401, 'no');
    }
    if (req.headers.authorization !== `Bearer ${jwt}`) return send(401, 'no');
    if (u.pathname.endsWith('/simple')) return send(200, JSON.stringify([{ typeKey: 'cycling', children: ['mountain_biking'] }, { typeKey: 'running', children: ['trail_running'] }]));
    if (u.pathname.endsWith('/search/activities')) {
      if (opts.rejectFilter && u.searchParams.has('activityType')) return send(400, '');
      if (opts.throttle && seen.throttles++ < 1) return send(429, '', { 'retry-after': '0' });
      const s = opts.ignoreStart ? 0 : Number(u.searchParams.get('start'));
      return send(200, JSON.stringify(rides.slice(s, s + Math.min(Number(u.searchParams.get('limit')), 50))));
    }
    if (u.pathname.startsWith('/download-service')) {
      if (u.pathname.endsWith('0') && opts.bad) return send(200, 'not a zip');
      return send(200, zip('900_ACTIVITY.fit', fit(30)));
    }
    send(404, '');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.closeAllConnections(); srv.close(); }
}
const run = (base, o = {}) => runTest({ key: KEY, base, log: () => {}, pause: 0, retryBase: 5, ...o });

test('lists every page and reads GPS from samples', () => withServer({}, async (b) => {
  const r = await run(b);
  assert.equal(r.rides.cycling, 250);
  assert.equal(r.rides.oldest, '2024-03-01');
  assert.equal(r.rides.newest, '2026-03-01');
  assert.equal(r.rides.largestPage, 50);
  assert.deepEqual(r.cyclingTypes, ['cycling', 'mountain_biking']);
  assert.equal(r.summary.samplesOk, 15);
  assert.equal(r.summary.withGps, 15);
  assert.equal(r.samples[0].files[0].gpsPoints, 30);
  assert.equal(r.samples[0].files[0].secondsPerPoint, 2);
  assert.ok(r.tokenHours > 23);
}));
test('report leaks no key, token, names, ids or coordinates', () => withServer({}, async (b) => {
  const s = JSON.stringify(await run(b));
  for (const x of [KEY, jwt, 'Private', '9000000', '12.3456']) assert.ok(!s.includes(x), x);
}));
test('rejected key', () => withServer({}, (b) => assert.rejects(run(b, { key: 'wrong' }), { status: 401 })));
test('refuses to follow a redirect with the key', () => withServer({}, (b2) =>
  withServer({ redirect: b2 }, (b) => assert.rejects(run(b)))));
test('waits and retries on 429', () => withServer({ throttle: true }, async (b) => {
  const r = await run(b);
  assert.equal(r.limits.throttled, 1);
  assert.equal(r.rides.cycling, 250);
}));
test('falls back when the cycling filter is rejected', () => withServer({ rejectFilter: true }, async (b) => {
  const r = await run(b);
  assert.equal(r.filterRejected, true);
  assert.equal(r.rides.cycling, 250);
}));
test('does not loop when paging is ignored', () => withServer({ ignoreStart: true }, async (b) => {
  const r = await run(b);
  assert.equal(r.repeatedPage, true);
  assert.equal(r.rides.cycling, 50);
}));
test('a bad file does not stop the run', () => withServer({ bad: true }, async (b) => {
  const r = await run(b);
  assert.ok(r.summary.samplesFailed > 0);
  assert.ok(r.summary.samplesOk > 0);
}));
test('no rides', () => withServer({ total: 0 }, async (b) => {
  const r = await run(b);
  assert.equal(r.rides.cycling, 0);
  assert.equal(r.summary.samplesOk, 0);
}));
test('helpers', async () => {
  assert.deepEqual(spread(3, 15), [0, 1, 2]);
  assert.equal(spread(7000, 15).at(-1), 6999);
  assert.equal(dayOf({ beginTimestamp: 1714550400000 }), '2024-05-01');
  assert.ok(!cyclingKeys([{ typeKey: 'running', children: ['trail_running'] }]).size);
  assert.deepEqual(await inspectZip(new Uint8Array(zip('a.gpx', Buffer.from('<gpx/>')))), [{ ext: 'gpx', bytes: 6 }]);
});
