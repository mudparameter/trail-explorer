import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncStatus } from '../core/api.ts';
import { Busy, Garmin, GarminError, KeyRejected, noGpsKind, Offline } from './garmin.ts';
import type { Store } from './store.ts';

export interface SyncDeps {
  store: Store;
  garmin: Garmin;
  ridesDir: string;
  /** Reads one downloaded .zip. Runs in the worker. */
  readRide(zip: Buffer): Promise<{ status: 'done' | 'no-gps' | 'unread'; track: Float64Array | null }>;
  /** New rides are stored; the heatmap should be rebuilt. */
  ridesChanged(): void;
  changed(): void;
  pause?: number;
  retryBase?: number;
}
const BATCH = 25;
/** This many refusals in a row means something is wrong with all of them. */
const MAX_REFUSED = 5;
const DAY = 86_400_000;

export class Sync {
  state: SyncStatus['state'] = 'idle';
  message = '';
  keyProblem: string | null = null;
  private d: SyncDeps;
  private running: Promise<void> | null = null;
  private abort = new AbortController();

  constructor(d: SyncDeps) {
    this.d = d;
  }
  private set(state: SyncStatus['state'], message = '') {
    this.state = state;
    this.message = message;
    this.d.changed();
  }

  start(): void {
    if (this.running) return;
    this.abort = new AbortController();
    this.running = this.run(this.abort.signal).finally(() => {
      this.running = null;
      this.d.changed();
    });
  }
  async stop(): Promise<void> {
    this.abort.abort();
    await this.running?.catch(() => {});
    this.set('idle');
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(t);
        reject(new Error('stopped'));
      };
      if (signal.aborted) return reject(new Error('stopped'));
      const t = setTimeout(() => {
        signal.removeEventListener('abort', stop);
        resolve();
      }, ms);
      signal.addEventListener('abort', stop, { once: true });
    });
  }

  /** Runs one Garmin call, waiting out busy spells and lost connections. */
  private async call<T>(fn: () => Promise<T>, signal: AbortSignal, back: SyncStatus['state']): Promise<T> {
    const base = this.d.retryBase ?? 30_000;
    for (let n = 0; ; n++) {
      try {
        const r = await fn();
        if (n) this.set(back);
        return r;
      } catch (e) {
        if (signal.aborted) throw e;
        const ms = Math.min(base * 2 ** Math.min(n, 10), 30 * 60_000);
        if (e instanceof Busy) {
          const w = Math.max(ms, e.retryAfterMs ?? 0);
          const mins = Math.ceil(w / 60_000);
          this.set('waiting', `Garmin asked the app to slow down. Trying again in ${mins} minute${mins === 1 ? '' : 's'}.`);
          await this.wait(Math.min(w, 2 * 3_600_000), signal);
        } else if (e instanceof Offline) {
          this.set('offline', 'Cannot reach Garmin. The app will keep trying.');
          await this.wait(Math.min(ms, 5 * 60_000), signal);
        } else throw e;
      }
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    const { store, garmin } = this.d;
    let fresh = 0;
    let refused = 0;
    try {
      this.set('listing', 'Looking for rides.');
      const started = new Date();
      // Syncs once listed only cycling. Every kind is listed now, so look through all of them once.
      if (store.get<string>('syncKinds') !== 'all') store.set('lastSyncStart', null);
      const last = store.get<string>('lastSyncStart');
      // A week of overlap catches rides uploaded late.
      const from = last ? new Date(Date.parse(last) - 7 * DAY).toISOString().slice(0, 10) : null;
      const seen = new Set<string>();
      for (let at = 0; ; ) {
        const page = await this.call(() => garmin.search(at, from, signal), signal, 'listing');
        const before = seen.size;
        for (const a of page.activities) seen.add(a.id);
        store.addRides(page.activities.filter((a) => !a.noMap && !noGpsKind(a.sport)));
        this.d.changed();
        // Stop at the end, or if Garmin repeats itself.
        if (!page.size || seen.size === before) break;
        at += page.size;
      }
      store.retryFailed();
      store.set('lastSyncStart', started.toISOString());
      store.set('syncKinds', 'all');
      this.keyProblem = null;

      this.set('downloading');
      await mkdir(this.d.ridesDir, { recursive: true });
      for (let next = store.nextWaiting(); next; next = store.nextWaiting()) {
        if (signal.aborted) return;
        const { id, tries } = next;
        try {
          const zip = await this.call(() => garmin.download(id, signal), signal, 'downloading');
          refused = 0;
          const name = `${id}.zip`;
          const tmp = join(this.d.ridesDir, `${name}.part`);
          await writeFile(tmp, zip);
          await rename(tmp, join(this.d.ridesDir, name));
          const r = await this.d.readRide(zip);
          if (signal.aborted) return;
          store.finishRide(id, r.status, name, r.track);
          if (r.status === 'done') fresh++;
        } catch (e) {
          if (signal.aborted) return;
          if (e instanceof KeyRejected) throw e;
          if (e instanceof GarminError && ++refused >= MAX_REFUSED) {
            throw new Error(`Garmin is refusing to send rides (answer ${e.status}). Try Sync now again later.`);
          }
          if (tries >= 1) store.finishRide(id, 'failed', null, null);
          else store.countTry(id);
        }
        if (fresh >= BATCH) {
          fresh = 0;
          this.d.ridesChanged();
        }
        this.d.changed();
        await this.wait(this.d.pause ?? 300, signal);
      }
      if (fresh) this.d.ridesChanged();
      store.set('lastSync', new Date().toISOString());
      this.set('idle');
    } catch (e) {
      if (signal.aborted) return;
      if (fresh) this.d.ridesChanged();
      if (e instanceof KeyRejected) {
        this.keyProblem = 'Garmin did not accept your key. It may have expired or been deleted.';
        this.set('key-rejected', this.keyProblem);
      } else this.set('error', e instanceof Error ? e.message : 'Something went wrong.');
    }
  }
}
