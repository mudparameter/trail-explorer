// Garmin personal API key test (ARD build step 1).
//
// Asks for your key in the terminal (input hidden), then checks how far back
// rides go, what the downloads contain, and how fast Garmin serves them.
// The key and token stay in memory only. The report has no key, ride names,
// ride ids or coordinates.
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import FitParser from 'fit-file-parser';

export const GARMIN = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const TYPES_PATH = '/activity-service/activity/activityTypes/simple';
const SEARCH_PATH = '/activitylist-service/activities/search/activities';
const MAX_ZIP = 100 * 1024 * 1024;
const MAX_UNZIPPED = 250 * 1024 * 1024;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, path) {
    super(`Garmin answered ${status} for ${path}`);
    this.status = status;
  }
}

/** Expiry of a JWT in ms, or null if the token is not a readable JWT. */
export function tokenExpiry(token) {
  try {
    const exp = Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Every spaced-out index from 0 to n-1, including both ends. */
export function spread(n, count) {
  if (n <= count) return [...Array(n).keys()];
  return [...new Set(Array.from({ length: count }, (_, i) => Math.round((i * (n - 1)) / (count - 1))))];
}

const startOf = (a) => String(a.startTimeGMT ?? a.startTimeLocal ?? a.beginTimestamp ?? '');
/** YYYY-MM-DD, accepting a text date or a millisecond timestamp. */
export function dayOf(a) {
  const s = startOf(a);
  if (/^\d{12,}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : 'unknown';
}
const typeOf = (a) => a.activityType?.typeKey ?? a.activityType ?? 'unknown';
const idOf = (a) => a.activityId ?? a.id;

/** Cycling type keys found anywhere in Garmin's type list, whatever its shape. */
export function cyclingKeys(types) {
  const keys = new Set();
  const visit = (node, inCycling) => {
    if (typeof node === 'string') {
      if (inCycling) keys.add(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach((n) => visit(n, inCycling));
    if (!node || typeof node !== 'object') return;
    const own = node.typeKey ?? node.key ?? node.activityType;
    const here = inCycling || own === 'cycling';
    if (here && typeof own === 'string') keys.add(own);
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') visit(v, here || k === 'cycling');
    }
  };
  visit(types, false);
  return keys;
}

export async function inspectZip(bytes) {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new Error('unzipped file is too large');
      return true;
    },
  });
  const out = [];
  for (const [name, data] of Object.entries(files)) {
    const ext = (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? 'none').toLowerCase();
    const entry = { ext, bytes: data.length };
    if (ext === 'fit') {
      const copy = Buffer.from(data);
      const fit = await new FitParser({ force: true, mode: 'list' }).parseAsync(copy);
      const records = fit.records ?? [];
      const gps = records.filter(
        (r) => Number.isFinite(r.position_lat) && Number.isFinite(r.position_long),
      );
      entry.points = records.length;
      entry.gpsPoints = gps.length;
      entry.altitudePoints = records.filter((r) => Number.isFinite(r.enhanced_altitude ?? r.altitude)).length;
      if (gps.length > 1) {
        const secs = (new Date(gps.at(-1).timestamp) - new Date(gps[0].timestamp)) / 1000;
        entry.secondsPerPoint = Number((secs / (gps.length - 1)).toFixed(2));
      }
    }
    out.push(entry);
  }
  return out;
}

export async function runTest({ key, base = GARMIN, log = console.log, pause = 400, samples = 15, retryBase = 30_000, retries = 3 }) {
  const stats = { requests: 0, throttled: 0, retriesUsed: 0, limitHeaders: {} };
  let token = null;

  async function request(path, { method = 'GET', params, auth, accept = 'application/json' } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      await wait(pause);
      const t0 = performance.now();
      // Never follow redirects: the key or token must only go to this host.
      const res = await fetch(url, {
        method,
        redirect: 'error',
        headers: { Accept: accept, Authorization: auth ?? `Bearer ${token}`, 'User-Agent': 'TrailExplorer/0.0' },
        signal: AbortSignal.timeout(60_000),
      });
      stats.requests++;
      for (const [h, v] of res.headers) {
        if (/rate-?limit|retry-after/i.test(h)) stats.limitHeaders[h] = v;
      }
      if (res.ok) {
        if (Number(res.headers.get('content-length') ?? 0) > MAX_ZIP) throw new Error('download is too large');
        const body = Buffer.from(await res.arrayBuffer());
        return { body, ms: performance.now() - t0 };
      }
      await res.body?.cancel();
      if (res.status === 429) stats.throttled++;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const after = Number(res.headers.get('retry-after'));
        const ms = after > 0 ? Math.min(after * 1000, 30 * 60_000) : retryBase * 2 ** attempt;
        stats.retriesUsed++;
        log(`  Garmin answered ${res.status}. Waiting ${Math.round(ms / 1000)} s.`);
        await wait(ms);
        continue;
      }
      throw new HttpError(res.status, path.replace(/\d{5,}/g, '{id}'));
    }
  }
  const json = async (path, params) => {
    const { body } = await request(path, { params });
    return body.length ? JSON.parse(body.toString()) : null;
  };

  const report = { ranAt: new Date().toISOString() };

  log('1. Checking the key...');
  const tok = await request(TOKEN_PATH, { method: 'POST', auth: `ApiKey ${key}`, accept: '*/*' });
  token = tok.body.toString().trim();
  const exp = tokenExpiry(token);
  report.tokenHours = exp ? Number(((exp - Date.now()) / 3_600_000).toFixed(1)) : null;
  log(`   Key works. Token lasts ${report.tokenHours ?? 'unknown'} hours.`);

  log('2. Listing cycling types...');
  let known = new Set();
  try {
    known = cyclingKeys(await json(TYPES_PATH));
  } catch (e) {
    report.typesError = e.message;
  }
  report.cyclingTypes = [...known].sort();
  log(`   ${known.size} found.`);

  log('3. Listing rides...');
  const rides = new Map();
  const pages = [];
  let filter = { activityType: 'cycling' };
  let start = 0;
  for (let page = 0; page < 1000; page++) {
    let list;
    const params = { start, limit: 100, ...filter };
    try {
      list = await json(SEARCH_PATH, params);
    } catch (e) {
      if (page === 0 && e.status === 400 && filter.activityType) {
        report.filterRejected = true;
        filter = {};
        page--;
        continue;
      }
      report.listingStoppedEarly = e.message;
      log(`   Stopped early: ${e.message}`);
      break;
    }
    const items = Array.isArray(list) ? list : (list?.activities ?? list?.activityList ?? []);
    pages.push(items.length);
    if (!items.length) break;
    const before = rides.size;
    for (const a of items) if (idOf(a) != null) rides.set(String(idOf(a)), a);
    if (rides.size === before) {
      report.repeatedPage = true; // Garmin ignored "start"; stop instead of looping.
      break;
    }
    start += items.length;
    process.stdout.isTTY && process.stdout.write(`\r   ${rides.size} so far`);
  }
  process.stdout.isTTY && process.stdout.write('\r');

  const all = [...rides.values()];
  const isCycling = (a) => {
    const t = String(typeOf(a));
    return known.has(t) || /cycling|biking|bike|bmx|cyclocross/.test(t);
  };
  const cycling = all.filter(isCycling).sort((a, b) => dayOf(a).localeCompare(dayOf(b)));
  const count = (xs, f) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
  const dated = cycling.filter((a) => dayOf(a) !== 'unknown');
  report.rides = {
    listed: all.length,
    cycling: cycling.length,
    oldest: dated.length ? dayOf(dated[0]) : null,
    newest: dated.length ? dayOf(dated.at(-1)) : null,
    perYear: count(cycling, (a) => dayOf(a).slice(0, 4)),
    perType: count(cycling, (a) => String(typeOf(a))),
    otherTypesListed: count(all.filter((a) => !isCycling(a)), (a) => String(typeOf(a))),
    startPositionInList: cycling.filter((a) => Number.isFinite(a.startLatitude)).length,
    pages: pages.length,
    largestPage: Math.max(0, ...pages),
  };
  log(`   ${cycling.length} rides, ${report.rides.oldest} to ${report.rides.newest}.`);

  log('4. Downloading sample rides...');
  report.samples = [];
  for (const i of spread(cycling.length, samples)) {
    const a = cycling[i];
    const s = { year: dayOf(a).slice(0, 4), type: String(typeOf(a)) };
    try {
      const { body, ms } = await request(`/download-service/files/activity/${encodeURIComponent(idOf(a))}`, {
        accept: 'application/zip, application/x-zip-compressed, application/octet-stream',
      });
      s.ms = Math.round(ms);
      s.zipBytes = body.length;
      s.files = await inspectZip(new Uint8Array(body));
      const f = s.files.find((x) => x.ext === 'fit');
      log(`   ${s.year} ${s.type}: ${s.files.map((x) => x.ext).join(', ')}${f ? `, ${f.gpsPoints} GPS points` : ''}, ${s.ms} ms`);
    } catch (e) {
      s.error = e.message;
      s.status = e.status;
      log(`   ${s.year} ${s.type}: ${e.message}`);
      if (e.status === 429) {
        report.samples.push(s);
        report.samplingStoppedEarly = 'rate limited';
        break;
      }
    }
    report.samples.push(s);
  }

  const good = report.samples.filter((s) => s.files);
  const avg = (f) => good.reduce((n, s) => n + f(s), 0) / good.length;
  report.summary = {
    samplesOk: good.length,
    samplesFailed: report.samples.length - good.length,
    withGps: good.filter((s) => s.files.some((f) => f.gpsPoints > 0)).length,
    fileTypes: count(good.flatMap((s) => s.files), (f) => f.ext),
  };
  if (good.length) {
    report.summary.averageDownloadMs = Math.round(avg((s) => s.ms));
    report.summary.averageZipKB = Math.round(avg((s) => s.zipBytes) / 1024);
    report.summary.estimatedFullImportHours = Number(
      ((cycling.length * (avg((s) => s.ms) + pause)) / 3_600_000).toFixed(1),
    );
    report.summary.estimatedFullImportGB = Number(((cycling.length * avg((s) => s.zipBytes)) / 1024 ** 3).toFixed(2));
  }
  report.limits = stats;
  return report;
}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const done = (fn) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      fn();
    };
    const onData = (chunk) => {
      // Drop the markers terminals put around pasted text.
      for (const c of chunk.replace(/\x1b\[20[01]~/g, '')) {
        if (c === '\r' || c === '\n') return done(() => resolve(value.trim()));
        if (c === '\x03') return done(() => reject(new Error('Cancelled.')));
        if (c === '\x7f') value = value.slice(0, -1);
        else if (c >= ' ') value += c;
      }
    };
    stdin.on('data', onData);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.stdin.isTTY) {
    console.error('Run this in your own Terminal window, so your key can be typed without being shown:\n  npm run check-garmin-key');
    process.exit(1);
  }
  try {
    const key = await askHidden('Paste your Garmin personal API key (it will not be shown), then press Enter: ');
    if (!key) throw new Error('No key entered.');
    const report = await runTest({ key });
    const dir = new URL('../.local/', import.meta.url);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL('check-garmin-key.json', dir), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log('\nSummary:', report.summary);
    console.log('Report saved to .local/check-garmin-key.json. It has no key, names, ids or locations in it.');
  } catch (e) {
    console.error(e.status === 401 || e.status === 403 ? `\nGarmin rejected the key (${e.status}).` : `\nTest failed: ${e.message}`);
    process.exitCode = 1;
  }
}
