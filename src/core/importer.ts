// Adds rides from an export .zip. The .zip itself is only read, never copied:
// each new ride is saved on its own, like a ride from Garmin, and rides already
// here, from Garmin or an earlier import, are left out. No Node, Electron or DOM
// here: the host says where rides are kept, and how to read the .zip.
import type { ImportStatus } from './api.ts';
import { startMs, type Found } from './import.ts';
import type { ReadFile } from './ride.ts';

/** Imported rides' ids start with this, then part of a hash of the file. */
export const IMPORTED = 'file-';

/** Where rides are kept: SQLite and a folder on the desktop, IndexedDB in a browser. */
export interface RideStore {
  has(id: string): boolean;
  /** Is there a ride starting within a couple of minutes of this? */
  near(ms: number): boolean;
  /** Saves a ride read from an export. `data` is the ride file, for hosts that keep a copy. */
  addImported(r: { id: string; startedAt: string; sport: string; name: string; status: 'done' | 'no-gps'; track: Float64Array | null; fileName: string; data: Uint8Array }): Promise<void>;
}

export interface ImportDeps {
  store: RideStore;
  /** Reads one ride file. Runs in a worker. */
  readFile(name: string, data: Uint8Array): Promise<ReadFile>;
  /** New rides were added: redraw the heatmap. */
  ridesChanged(): void;
  /** The status changed. */
  changed(): void;
}

/** New rides between heatmap redraws. */
const BATCH = 50;

const base = (name: string) => name.slice(name.lastIndexOf('/') + 1);

/** An imported ride's id, from its file: the same file always gets the same id, in either app. */
export async function importedId(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
  return IMPORTED + [...hash].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

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

  /** Reads the ride files in an export called `file`. Resolves when done; progress is in `status`. */
  async run(file: string, files: () => AsyncIterable<Found>): Promise<ImportStatus> {
    if (this.running) throw new Error('An import is already running.');
    this.running = true;
    this.stopped = false;
    const s: ImportStatus = { state: 'reading', file, found: 0, added: 0, had: 0, noGps: 0, unread: 0, skipped: 0, other: 0, message: '' };
    this.status = s;
    this.d.changed();
    const { store } = this.d;
    let fresh = 0;
    try {
      for await (const f of files()) {
        if (this.stopped) return s;
        s.found++;
        const id = await importedId(f.data);
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
        else if (ms === null) s.other++;
        else if (store.near(ms)) s.had++;
        else {
          const status = r.status === 'done' ? 'done' : 'no-gps';
          const name = base(f.name).replace(/\.(fit|gpx|tcx)(\.gz)?$/i, '').slice(0, 200);
          // Rides without GPS are noted too, so they are not imported again.
          await store.addImported({ id, startedAt: new Date(ms).toISOString(), sport: r.sport ?? 'unknown', name, status, track: r.track, fileName: base(f.name), data: f.data });
          if (status === 'done') {
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
  if (s.found === s.other) return 'None of the files in that .zip are activities.';
  const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
  const parts = [`${n(s.added, 'new ride')} added`];
  if (s.had) parts.push(`${n(s.had, 'ride')} already here`);
  if (s.noGps) parts.push(`${s.noGps} without GPS`);
  if (s.skipped) parts.push(`${s.skipped} indoor or virtual left out`);
  if (s.unread) parts.push(`${s.unread} could not be read`);
  if (s.other) parts.push(`${n(s.other, 'other file')} (such as daily health data) left out`);
  return `${parts.join(', ')}.`;
}
