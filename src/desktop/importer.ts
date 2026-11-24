// Adds rides from an export .zip. The .zip itself is only read, never copied:
// each new ride is saved on its own, like a ride from Garmin, and rides the app
// already has, from Garmin or an earlier import, are left out.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { zipSync } from 'fflate';
import type { ImportStatus } from '../core/api.ts';
import { rideFiles, startMs } from '../core/import.ts';
import type { ReadFile } from '../core/ride.ts';
import { IMPORTED, type Store } from './store.ts';

export interface ImportDeps {
  store: Store;
  ridesDir: string;
  /** Reads one ride file. Runs in the worker. */
  readFile(name: string, data: Uint8Array): Promise<ReadFile>;
  ridesChanged(): void;
  changed(): void;
}

/** New rides between heatmap redraws. */
const BATCH = 50;

export class Importer {
  status: ImportStatus | null = null;
  private d: ImportDeps;
  private running = false;
  private stopped = false;

  constructor(d: ImportDeps) {
    this.d = d;
  }

  stop() {
    this.stopped = true;
  }

  /** Reads the export at `path`. Resolves when done; progress is in `status`. */
  async run(path: string): Promise<ImportStatus> {
    if (this.running) throw new Error('An import is already running.');
    this.running = true;
    this.stopped = false;
    const s: ImportStatus = { state: 'reading', file: basename(path), found: 0, added: 0, had: 0, noGps: 0, unread: 0, skipped: 0, message: '' };
    this.status = s;
    this.d.changed();
    const { store } = this.d;
    let fresh = 0;
    try {
      await mkdir(this.d.ridesDir, { recursive: true });
      for await (const f of rideFiles(createReadStream(path, { highWaterMark: 1 << 20 }))) {
        if (this.stopped) return s;
        s.found++;
        const id = IMPORTED + createHash('sha256').update(f.data).digest('hex').slice(0, 20);
        let r: ReadFile;
        try {
          if (store.has(id)) throw new Error('had');
          r = await this.d.readFile(f.name, f.data);
        } catch (e) {
          if (e instanceof Error && e.message === 'had') s.had++;
          else s.unread++;
          this.d.changed();
          continue;
        }
        if (this.stopped) return s;
        const ms = startMs(r.startedAt);
        if (r.indoor) s.skipped++;
        else if (ms === null) s.unread++;
        else if (store.near(ms)) s.had++;
        else {
          // Only rides with GPS are kept as files; the rest are noted so they are not imported again.
          let file: string | null = null;
          if (r.status === 'done') {
            file = `${id}.zip`;
            const tmp = join(this.d.ridesDir, `${file}.part`);
            await writeFile(tmp, zipSync({ [basename(f.name)]: f.data }));
            await rename(tmp, join(this.d.ridesDir, file));
          }
          const name = basename(f.name).replace(/\.(fit|gpx|tcx)(\.gz)?$/i, '').slice(0, 200);
          store.addImported({ id, startedAt: new Date(ms).toISOString(), sport: r.sport ?? 'unknown', name, status: r.status, file, track: r.track });
          if (r.status === 'done') {
            s.added++;
            if (++fresh >= BATCH) {
              fresh = 0;
              this.d.ridesChanged();
            }
          } else s.noGps++;
        }
        this.d.changed();
      }
      s.state = 'done';
      s.message = summary(s);
    } catch (e) {
      s.state = 'error';
      s.message = `${e instanceof Error ? e.message : 'The file could not be read.'} ${s.added ? `${s.added} new ride${s.added === 1 ? ' was' : 's were'} added before that.` : ''}`.trim();
      console.error('Import failed:', e);
    } finally {
      this.running = false;
      if (s.added) this.d.ridesChanged();
      this.d.changed();
    }
    return s;
  }
}

function summary(s: ImportStatus): string {
  if (!s.found) return 'No ride files (.fit, .gpx or .tcx) were found in that file.';
  const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
  const parts = [`${n(s.added, 'new ride')} added`];
  if (s.had) parts.push(`${n(s.had, 'ride')} already here`);
  if (s.noGps) parts.push(`${s.noGps} without GPS`);
  if (s.skipped) parts.push(`${s.skipped} indoor or virtual left out`);
  if (s.unread) parts.push(`${s.unread} could not be read`);
  return `${parts.join(', ')}.`;
}
