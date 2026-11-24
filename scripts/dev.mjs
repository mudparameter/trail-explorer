// Starts the app with hot reload:  npm run dev
//
// The first time, it copies your rides and config folder (maps and zones
// included) from the real app into a separate development folder. The Garmin
// key is never copied.
//   npm run dev -- --fresh-copy   copies them again, replacing the dev copies
import { spawn } from 'node:child_process';
import { constants, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { sandboxProblem } from './check-sandbox.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Where Electron keeps app data on each system (its appData path).
const support = {
  darwin: join(homedir(), 'Library', 'Application Support'),
  win32: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
}[process.platform] ?? (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
const real = join(support, 'Trail Explorer');
const dev = join(support, 'Trail Explorer Dev');
const db = 'trail-explorer.db';
const args = process.argv.slice(2);

const problem = sandboxProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}
const again = args.includes('--fresh-copy');

if (existsSync(join(real, db)) && (again || !existsSync(join(dev, db)))) {
  mkdirSync(dev, { recursive: true });
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(join(dev, f), { force: true });
  rmSync(join(dev, 'maps'), { recursive: true, force: true });
  // VACUUM INTO makes a consistent copy even while the real app is running.
  const src = new DatabaseSync(join(real, db));
  src.prepare('VACUUM INTO ?').run(join(dev, db));
  src.close();
  const copy = new DatabaseSync(join(dev, db));
  copy.exec("DELETE FROM setting WHERE k = 'keyExpires'");
  const n = copy.prepare("SELECT count(*) AS n FROM ride WHERE status = 'done'").get().n;
  copy.close();
  if (existsSync(join(real, 'maps'))) cpSync(join(real, 'maps'), join(dev, 'maps'), { recursive: true, mode: constants.COPYFILE_FICLONE });
  console.log(`Copied ${n} rides into the development copy.`);
}
// Downloaded roads and trails, so the dev copy's areas need not download them again.
const osm = 'osm.db';
if (existsSync(join(real, osm)) && (again || !existsSync(join(dev, osm)))) {
  mkdirSync(dev, { recursive: true });
  for (const f of [osm, `${osm}-wal`, `${osm}-shm`]) rmSync(join(dev, f), { force: true });
  const src = new DatabaseSync(join(real, osm));
  src.prepare('VACUUM INTO ?').run(join(dev, osm));
  src.close();
  console.log('Copied the downloaded roads and trails into the development copy.');
}
// The config folder holds the zones, so the dev copy hides the same places.
if (existsSync(join(real, 'config')) && (again || !existsSync(join(dev, 'config')))) {
  rmSync(join(dev, 'config'), { recursive: true, force: true });
  cpSync(join(real, 'config'), join(dev, 'config'), { recursive: true, mode: constants.COPYFILE_FICLONE });
  console.log('Copied the config folder into the development copy.');
}

const bin = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
const child = spawn(process.execPath, [bin, 'dev', '--watch', ...args.filter((a) => a !== '--fresh-copy')], { cwd: root, stdio: 'inherit' });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
child.on('exit', (code) => process.exit(code ?? 0));
