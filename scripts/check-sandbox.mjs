// Before starting Electron on Linux, checks that its sandbox can run, and says
// how to fix it if not. Without this Electron stops with a hard-to-read error.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Null when Electron can start, otherwise what to do about it. */
export function sandboxProblem() {
  if (process.platform !== 'linux') return null;
  const read = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return null; } };
  // Only Ubuntu-style AppArmor restrictions block it. Elsewhere user namespaces just work.
  if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') !== '1') return null;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const electron = join(root, 'node_modules', 'electron', 'dist', 'electron');
  if (read('/etc/apparmor.d/trail-explorer-dev')?.includes(`"${electron}"`)) return null;
  try {
    const s = statSync(join(root, 'node_modules', 'electron', 'dist', 'chrome-sandbox'));
    if (s.uid === 0 && s.mode & 0o4000) return null;
  } catch {}
  return 'Ubuntu blocks the sandbox Electron needs. Allow it once for this folder with:\n\n  sudo scripts/linux-sandbox.sh\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = sandboxProblem();
  if (p) {
    console.error(p);
    process.exit(1);
  }
}
