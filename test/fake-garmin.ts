import http from 'node:http';
import { zipSync } from 'fflate';
import { FitBaseType, FitEncoder } from 'fit-file-parser';

export const KEY = 'made-up-key';
const semi = (d: number) => Math.round((d * 2 ** 31) / 180);

/** A made-up .fit ride through lon/lat points, 2 s apart. */
export function fit(points: [number, number][], start = '2025-05-01T08:00:00Z'): Uint8Array {
  const e = new FitEncoder();
  const t0 = FitEncoder.toFitTimestamp(new Date(start));
  e.writeMessage(0, [{ number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 }, { number: 4, size: 4, baseType: FitBaseType.Uint32, value: t0 }]);
  points.forEach(([lon, lat], i) => e.writeMessage(20, [
    { number: 253, size: 4, baseType: FitBaseType.Uint32, value: t0 + i * 2 },
    { number: 0, size: 4, baseType: FitBaseType.Sint32, value: semi(lat) },
    { number: 1, size: 4, baseType: FitBaseType.Sint32, value: semi(lon) },
  ], 1));
  return e.close();
}
export const zipOf = (name: string, data: Uint8Array) => Buffer.from(zipSync({ [name]: data }));

export interface Fake {
  base: string;
  close(): void;
  /** Change behaviour while running. */
  opts: FakeOpts;
  downloads: string[];
  /** The startDate of each list request, '' for none. */
  searches: string[];
  tokens: number;
}
export interface FakeOpts {
  rides: { id: number; type?: string; start?: string; body?: Buffer; noMap?: boolean }[];
  rejectKey?: boolean;
  revokeToken?: boolean;
  busy?: number;
  delay?: number;
  refuse?: boolean;
}
export async function fakeGarmin(opts: FakeOpts): Promise<Fake> {
  let n = 0;
  let valid = '';
  const f: Fake = { base: '', close: () => {}, opts, downloads: [], searches: [], tokens: 0 };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x');
    const send = (c: number, b: string | Buffer = '') => { res.writeHead(c); res.end(b); };
    if (u.pathname.endsWith('/token')) {
      if (opts.rejectKey || req.headers.authorization !== `ApiKey ${KEY}`) return send(401);
      f.tokens++;
      valid = `x.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 86400, n: n++ })).toString('base64url')}.y`;
      return send(200, valid);
    }
    if (opts.revokeToken) { opts.revokeToken = false; valid = ''; }
    if (req.headers.authorization !== `Bearer ${valid}` || opts.rejectKey) return send(401);
    if (opts.busy) { opts.busy--; return send(429); }
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    if (u.pathname.endsWith('/search/activities')) {
      const s = Number(u.searchParams.get('start'));
      const from = u.searchParams.get('startDate') ?? '';
      const kind = u.searchParams.get('activityType');
      if (s === 0) f.searches.push(from);
      // Like Garmin: a type asks for that type and its subtypes.
      const list = opts.rides.filter((r) => (r.start ?? '2025-01-01') >= from && (!kind || (r.type ?? 'mountain_biking').includes(kind === 'cycling' ? 'bik' : kind))).slice(s, s + 100);
      return send(200, JSON.stringify(list.map((r) => ({
        activityId: r.id, activityName: 'Made up', distance: 1000, startTimeGMT: r.start ?? '2025-01-01 10:00:00', activityType: { typeKey: r.type ?? 'mountain_biking' }, hasPolyline: !r.noMap,
      }))));
    }
    const m = u.pathname.match(/\/download-service\/files\/activity\/(\d+)$/);
    if (m && (opts.refuse || !req.headers.accept?.includes('application/x-zip-compressed'))) { f.downloads.push(m[1]!); return send(406); }
    const ride = m && opts.rides.find((r) => r.id === Number(m[1]));
    if (ride) { f.downloads.push(m![1]!); return send(200, ride.body ?? Buffer.alloc(0)); }
    send(404);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  f.base = `http://127.0.0.1:${(srv.address() as any).port}`;
  f.close = () => { srv.closeAllConnections(); srv.close(); };
  return f;
}
