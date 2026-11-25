// The config on the website: the same files as the desktop app's config folder,
// kept in the browser's database. It counts changes made since the last export,
// so the app can remind people to save a copy to a file.
import type { Backup } from '../core/api.ts';
import { DEFAULTS, FILES, fileText, parseConfig, type Config, type Problem } from '../core/config.ts';
import { isConfigPath, type ConfigFiles } from '../core/configzip.ts';
import { parseRoutes, ROUTES_FILE } from '../core/routes.ts';
import { all, get, put } from './idb.ts';

export class ConfigStore {
  private files: ConfigFiles = {};
  backup: Backup = { unsaved: 0, since: null, lastExport: null };

  /** Reads the stored config, making a fresh one the first time. */
  async open() {
    this.files = Object.fromEntries((await all<string>('files')).map(([k, v]) => [String(k), v]));
    this.backup = (await get<Backup>('meta', 'backup')) ?? this.backup;
    if (!Object.keys(this.files).length) {
      // A new config is not a change: there is nothing to lose yet.
      const fresh = Object.fromEntries(FILES.map((f) => [f, fileText(f, DEFAULTS)]));
      await put('files', Object.entries(fresh));
      this.files = fresh;
    }
  }

  load(): { config: Config; problems: Problem[] } {
    return parseConfig(this.files);
  }

  read(path: string): string | undefined {
    return this.files[path];
  }

  /** Every config file, for exporting. */
  all(): ConfigFiles {
    return { ...this.files };
  }

  async write(path: string, text: string) {
    if (!isConfigPath(path)) throw new Error(`The app does not write ${path}.`);
    await this.save([[path, text]]);
  }

  async remove(path: string) {
    await this.save([[path, undefined]]);
  }

  /**
   * Writes the files from an imported config. Saved routes no longer listed in
   * its routes.json are deleted; other files not in it are kept, as on the desktop.
   */
  async importFiles(files: ConfigFiles) {
    const changes: [string, string | undefined][] = Object.entries(files).filter(([p]) => isConfigPath(p) && p !== 'README.md');
    if (files[ROUTES_FILE] !== undefined) {
      const keep = new Set(parseRoutes(files[ROUTES_FILE]).map((r) => `routes/${r.id}.gpx`));
      for (const p of Object.keys(this.files)) if (p.startsWith('routes/') && !keep.has(p) && files[p] === undefined) changes.push([p, undefined]);
    }
    await this.save(changes);
  }

  /** After an export everything is in a file. */
  async exported() {
    this.backup = { unsaved: 0, since: null, lastExport: new Date().toISOString() };
    await put('meta', [['backup', this.backup]]);
  }

  private async save(changes: [string, string | undefined][]) {
    if (!changes.length) return;
    const backup: Backup = { ...this.backup, unsaved: this.backup.unsaved + 1, since: this.backup.since ?? new Date().toISOString() };
    // Files first: if the count is lost, a reminder comes late, but no change is.
    await put('files', changes);
    await put('meta', [['backup', backup]]);
    for (const [p, t] of changes) {
      if (t === undefined) delete this.files[p];
      else this.files[p] = t;
    }
    this.backup = backup;
  }
}
