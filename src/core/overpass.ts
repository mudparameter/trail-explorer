// Asks Overpass servers for OpenStreetMap data. Public servers are often full, so
// busy answers are retried, then the next server is tried. No Node, Electron or
// DOM here: the host passes in how to fetch.

const BUSY = [429, 502, 503, 504];
const WAITS = [0, 3000, 8000, 20000];

export interface OverpassHost {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** False when the computer is known to be offline. */
  online(): boolean;
  /** Waits between tries. Tests make it quicker. */
  sleep?(ms: number): Promise<void>;
}

/** Runs a query on the first server that answers it. Throws a message for people when none does. */
export async function overpass(servers: string[], query: string, host: OverpassHost): Promise<unknown> {
  const sleep = host.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const body = new URLSearchParams({ data: query }).toString();
  let why = 'busy';
  for (const server of servers) {
    for (const ms of WAITS) {
      if (ms) await sleep(ms);
      let res: Response;
      try {
        res = await host.fetch(server, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(180_000),
        });
      } catch (e) {
        if (!host.online()) throw new Error('No internet. Downloading roads and trails needs it. Try again when you are online.');
        why = (e as Error).name === 'TimeoutError' ? 'slow' : 'unreachable';
        break; // try the next server
      }
      if (BUSY.includes(res.status)) {
        why = 'busy';
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) {
        why = `error ${res.status}`;
        break;
      }
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        why = 'garbled';
        break;
      }
      // Overpass reports running out of time or memory here, with a 200.
      if (typeof json?.remark === 'string' && /error/i.test(json.remark)) {
        why = 'unfinished';
        break;
      }
      return json;
    }
  }
  const name = servers.length === 1 ? new URL(servers[0]!).host : 'Every map data server';
  throw new Error(
    why === 'busy' ? `${name} is busy. Try again in a minute, or add another server in Customize.`
      : why === 'slow' ? `${name} took too long. Try again later.`
      : why === 'unfinished' ? `${name} could not finish. Try again later.`
      : why === 'unreachable' ? `Could not reach ${name}.`
      : `${name} sent something unexpected (${why}).`,
  );
}
