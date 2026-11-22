// Garmin personal API client. Paths come from Garmin's own Python client:
// github.com/garmin/connect-personal-api-python
export const GARMIN = 'https://personal.connectapi.garmin.com';
const TOKEN = '/personalapitoken-service/personal-api/personal-api-key/token';
const SEARCH = '/activitylist-service/activities/search/activities';
const MAX_BODY = 100 * 1024 * 1024;
const HOUR = 3_600_000;

export class KeyRejected extends Error {}
export class Offline extends Error {}
export class Busy extends Error {
  retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null) {
    super(`Garmin is busy (${status}).`);
    this.retryAfterMs = retryAfterMs;
  }
}
export class GarminError extends Error {
  status: number;
  constructor(status: number) {
    super(`Garmin answered ${status}.`);
    this.status = status;
  }
}

export interface Activity {
  id: string;
  startedAt: string;
  sport: string;
  name: string;
  distance: number | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Reads one entry of Garmin's list, or null if it has no usable id. */
export function toActivity(a: any): Activity | null {
  const id = String(a?.activityId ?? '');
  if (!/^\d{1,20}$/.test(id)) return null;
  const sport = str(a.activityType?.typeKey) || str(a.activityType) || 'cycling';
  return {
    id,
    startedAt: str(a.startTimeGMT) || str(a.startTimeLocal),
    sport,
    name: str(a.activityName).slice(0, 200),
    distance: Number.isFinite(a.distance) ? a.distance : null,
  };
}
/** Virtual rides have GPS, but not for anywhere you have been. */
export const isVirtual = (sport: string) => /virtual/.test(sport);

export function tokenExpiry(token: string): number {
  try {
    const exp = Number(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp);
    if (exp > 0) return exp * 1000;
  } catch {}
  return Date.now() + 2 * HOUR; // Unreadable: ask again fairly soon.
}

export class Garmin {
  private base: string;
  private getKey: () => Promise<string | null>;
  private token: string | null = null;
  private expires = 0;

  constructor(getKey: () => Promise<string | null>, base = GARMIN) {
    this.getKey = getKey;
    this.base = base;
  }
  forget() {
    this.token = null;
  }

  private async send(path: string, auth: string, method = 'GET', accept = 'application/json', signal?: AbortSignal): Promise<Buffer> {
    let res: Response;
    const timeout = AbortSignal.timeout(60_000);
    try {
      // Never follow redirects: the key and token must only go to this host.
      res = await fetch(this.base + path, {
        method,
        redirect: 'error',
        headers: { Accept: accept, Authorization: auth, 'User-Agent': 'TrailExplorer/0.1' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Offline('Could not reach Garmin.');
    }
    if (res.ok) {
      if (Number(res.headers.get('content-length') ?? 0) > MAX_BODY) throw new Error('The download is too large.');
      try {
        return Buffer.from(await res.arrayBuffer());
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new Offline('The connection to Garmin dropped.');
      }
    }
    await res.body?.cancel();
    if (res.status === 429 || res.status >= 500) {
      const s = Number(res.headers.get('retry-after'));
      throw new Busy(res.status, s > 0 ? s * 1000 : null);
    }
    throw new GarminError(res.status);
  }

  /** Exchanges a key for a token. Throws KeyRejected if Garmin refuses it. */
  async exchange(key: string, signal?: AbortSignal): Promise<string> {
    try {
      return (await this.send(TOKEN, `ApiKey ${key}`, 'POST', '*/*', signal)).toString().trim();
    } catch (e) {
      if (e instanceof GarminError && [400, 401, 403].includes(e.status)) throw new KeyRejected('Garmin did not accept this key.');
      throw e;
    }
  }
  private async bearer(signal?: AbortSignal): Promise<string> {
    if (!this.token || this.expires - Date.now() < HOUR) {
      const key = await this.getKey();
      if (!key) throw new KeyRejected('No Garmin key is saved.');
      this.token = await this.exchange(key, signal);
      this.expires = tokenExpiry(this.token);
    }
    return this.token;
  }
  private async get(path: string, accept?: string, signal?: AbortSignal): Promise<Buffer> {
    try {
      return await this.send(path, `Bearer ${await this.bearer(signal)}`, 'GET', accept, signal);
    } catch (e) {
      if (!(e instanceof GarminError) || (e.status !== 401 && e.status !== 403)) throw e;
      // The token may have been revoked. Get one new one, once. If the key
      // itself is bad, that throws KeyRejected.
      this.forget();
      return this.send(path, `Bearer ${await this.bearer(signal)}`, 'GET', accept, signal);
    }
  }

  async search(start: number, from: string | null, signal?: AbortSignal): Promise<{ size: number; activities: Activity[] }> {
    const q = new URLSearchParams({ start: String(start), limit: '100', activityType: 'cycling' });
    if (from) q.set('startDate', from);
    const body = await this.get(`${SEARCH}?${q}`, undefined, signal);
    const list = body.length ? JSON.parse(body.toString()) : [];
    if (!Array.isArray(list)) throw new Error('Garmin sent a list the app does not understand.');
    return { size: list.length, activities: list.map(toActivity).filter((a) => a !== null) };
  }
  download(id: string, signal?: AbortSignal): Promise<Buffer> {
    // Keep this header the same as Garmin's own client.
    return this.get(`/download-service/files/activity/${id}`, 'application/zip, application/x-zip-compressed, application/octet-stream', signal);
  }
}
