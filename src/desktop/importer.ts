// Adds rides from an export .zip on disk. The import itself is core/importer.ts;
// here each new ride with GPS is kept as its own small .zip in the rides folder,
// like a ride from Garmin.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { zipSync } from 'fflate';
import type { ImportStatus } from '../core/api.ts';
import { Importer as Core } from '../core/importer.ts';
import type { ReadFile } from '../core/ride.ts';
import type { Store } from './store.ts';
import { rideFilesIn } from './zipread.ts';

export interface ImportDeps {
  store: Store;
  ridesDir: string;
  /** Holds zips inside the export while they are read. */
  tmpDir: string;
  /** Reads one ride file. Runs in the worker. */
  readFile(name: string, data: Uint8Array): Promise<ReadFile>;
  ridesChanged(): void;
  changed(): void;
}

export class Importer {
  private core: Core;
  private d: ImportDeps;

  constructor(d: ImportDeps) {
    this.d = d;
    this.core = new Core({
      readFile: d.readFile, ridesChanged: d.ridesChanged, changed: d.changed,
      store: {
        has: (id) => d.store.has(id),
        near: (ms) => d.store.near(ms),
        addImported: async (r) => {
          let file: string | null = null;
          if (r.status === 'done') {
            file = `${r.id}.zip`;
            const tmp = join(d.ridesDir, `${file}.part`);
            await writeFile(tmp, zipSync({ [r.fileName]: r.data }));
            await rename(tmp, join(d.ridesDir, file));
          }
          d.store.addImported({ id: r.id, startedAt: r.startedAt, sport: r.sport, name: r.name, status: r.status, file, track: r.track });
        },
      },
    });
  }

  get status(): ImportStatus | null {
    return this.core.status;
  }

  stop() {
    this.core.stop();
  }

  /** Reads the export at `path`. Resolves when done; progress is in `status`. */
  async run(path: string): Promise<ImportStatus> {
    await mkdir(this.d.ridesDir, { recursive: true });
    await mkdir(this.d.tmpDir, { recursive: true });
    return this.core.run(basename(path), () => rideFilesIn(path, this.d.tmpDir));
  }
}
