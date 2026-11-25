// A whole config as one .zip file, laid out like the config folder, so it moves
// between the desktop app, the website and a backup unchanged. Map files are
// left out unless asked for: they are big, and can be added again.
// No Node, Electron or DOM here.
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { AREAS_FILE } from './areas.ts';
import { CONFIG_README } from './config-readme.ts';
import { FILES, parseConfig, type Problem } from './config.ts';
import { isRouteId, ROUTES_FILE } from './routes.ts';

/** The text files a config has, by path inside the folder. */
export type ConfigFiles = Record<string, string>;

/** Whether a path is one of the config's text files. Map files are separate. */
export function isConfigPath(path: string): boolean {
  return (FILES as readonly string[]).includes(path) || path === AREAS_FILE || path === ROUTES_FILE || path === 'README.md'
    || isRouteId(path.match(/^routes\/([a-z0-9]+)\.gpx$/)?.[1])
    || /^zones\/[^/\\]{1,100}\.(geo)?json$/i.test(path);
}
const isMapPath = (path: string) => /^maps\/[^/\\]{1,200}\.(pmtiles|mbtiles)$/i.test(path);

/** Text files bigger than this are left out, as the config folder does. */
const MAX_TEXT = 20 * 1024 ** 2;
/** All text files together. Stops a .zip that unpacks to far more than it looks. */
const MAX_TOTAL_TEXT = 200 * 1024 ** 2;

/** A .zip of the config, with a README so it explains itself. `maps` are map files to include, by path. */
export function configZip(files: ConfigFiles, maps: Record<string, Uint8Array> = {}): Uint8Array {
  const z: Zippable = { 'README.md': strToU8(CONFIG_README) };
  for (const [path, text] of Object.entries(files)) if (isConfigPath(path) && path !== 'README.md') z[path] = strToU8(text);
  // Map files are compressed already.
  for (const [path, data] of Object.entries(maps)) if (isMapPath(path)) z[path] = [data, { level: 0 }];
  return zipSync(z, { level: 6, mtime: new Date() });
}

export interface ReadZip {
  files: ConfigFiles;
  /** Map files in the .zip, by path. Only kept when asked for. */
  maps: Record<string, Uint8Array>;
  /** What was wrong in the files, as the config reads them. The config is still usable. */
  problems: Problem[];
  /** Paths in the .zip that are not part of a config, left out. */
  skipped: string[];
}

/**
 * Reads a config .zip. It may hold the files at the top, or inside one folder
 * (as when a folder is zipped). Throws when it is not a config at all.
 */
export function readConfigZip(data: Uint8Array, { withMaps = false } = {}): ReadZip {
  let entries: Record<string, Uint8Array>;
  let total = 0;
  try {
    entries = unzipSync(data, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        const big = /\.(pmtiles|mbtiles)$/i.test(f.name);
        if (big) return withMaps;
        if (f.originalSize > MAX_TEXT) return false;
        total += f.originalSize;
        if (total > MAX_TOTAL_TEXT) throw new Error('too big');
        return true;
      },
    });
  } catch (e) {
    throw new Error((e as Error).message === 'too big' ? 'That .zip unpacks to more than 200 MB of text, which is too much for a config.' : 'That file is not a .zip, or it is damaged.');
  }
  // One folder around everything: look inside it.
  const names = Object.keys(entries).filter((n) => !/(^|\/)(__MACOSX|\.DS_Store)/.test(n));
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const prefix = tops.size === 1 && names.every((n) => n.includes('/')) && !isConfigPath(names[0]!) ? `${[...tops][0]}/` : '';
  const files: ConfigFiles = {};
  const maps: Record<string, Uint8Array> = {};
  const skipped: string[] = [];
  for (const name of names) {
    const path = name.slice(prefix.length);
    if (isConfigPath(path)) files[path] = strFromU8(entries[name]!);
    else if (withMaps && isMapPath(path)) maps[path] = entries[name]!;
    else skipped.push(path);
  }
  const known = Object.keys(files).filter((p) => p !== 'README.md');
  if (!known.length) throw new Error('That .zip has no Trail Explorer config in it: no map.json, layers.json, areas.json or routes.');
  delete files['README.md'];
  return { files, maps, problems: parseConfig(files).problems, skipped };
}
