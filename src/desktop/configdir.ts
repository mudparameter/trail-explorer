// Reads, writes and watches the config folder on disk. What the files mean is in core/config.ts.
import { watch, type FSWatcher } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { APP_ZONES, FILES, fileText, parseConfig, type Config, type Problem } from '../core/config.ts';
import { CONFIG_README } from '../core/config-readme.ts';

const MAX_FILE = 20 * 1024 ** 2;
/** The only files the app writes. Map files go through Maps. */
const WRITABLE = new Set<string>([...FILES, APP_ZONES]);

export class ConfigDir {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  async exists() {
    return stat(this.dir).then((s) => s.isDirectory(), () => false);
  }

  /** Makes a new folder holding `config`, with a README and empty maps and zones folders. */
  async create(config: Config) {
    // Only you can read it: zones show where you live.
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    await mkdir(join(this.dir, 'maps'), { recursive: true });
    await mkdir(join(this.dir, 'zones'), { recursive: true });
    await writeFile(join(this.dir, 'README.md'), CONFIG_README);
    for (const f of FILES) await this.write(f, fileText(f, config));
  }

  /** Every file that matters, keyed by path inside the folder. */
  async files(): Promise<{ files: Record<string, string>; problems: Problem[] }> {
    const files: Record<string, string> = {};
    const problems: Problem[] = [];
    const zones = await readdir(join(this.dir, 'zones')).catch(() => [] as string[]);
    for (const f of [...FILES, ...zones.filter((z) => /\.(geo)?json$/i.test(z)).map((z) => `zones/${z}`)]) {
      try {
        const s = await stat(join(this.dir, f));
        if (!s.isFile()) continue;
        if (s.size > MAX_FILE) {
          problems.push({ file: f, message: 'The file is too large (over 20 MB), so it is ignored.' });
          continue;
        }
        files[f] = await readFile(join(this.dir, f), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') problems.push({ file: f, message: `Could not be read: ${(e as Error).message}` });
      }
    }
    return { files, problems };
  }

  async load(): Promise<{ config: Config; problems: Problem[] }> {
    const { files, problems } = await this.files();
    const r = parseConfig(files);
    return { config: r.config, problems: [...problems, ...r.problems] };
  }

  async read(file: string): Promise<string | undefined> {
    return readFile(join(this.dir, file), 'utf8').catch(() => undefined);
  }

  /** Replaces a file in one step, so a crash or a watcher never sees half of it. */
  async write(file: string, text: string) {
    if (!WRITABLE.has(file)) throw new Error(`The app does not write ${file}.`);
    const full = join(this.dir, file);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.part`;
    await writeFile(tmp, text);
    await rename(tmp, full);
  }

  /** Calls `fn` shortly after anything in the folder changes. Returns a function that stops watching. */
  watch(fn: () => void): () => void {
    let t: NodeJS.Timeout | undefined;
    let w: FSWatcher | null = null;
    try {
      w = watch(this.dir, { recursive: true }, (_e, name) => {
        if (name && (name.endsWith('.part') || /(^|[/\\])\./.test(name))) return;
        clearTimeout(t);
        t = setTimeout(fn, 250);
      });
      w.on('error', (e) => console.error('Config folder watch stopped:', e));
    } catch (e) {
      console.error('Could not watch the config folder:', e);
    }
    return () => {
      clearTimeout(t);
      w?.close();
    };
  }
}
