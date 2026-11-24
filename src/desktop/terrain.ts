// Downloads the elevation tiles route planning needs, and keeps them in the
// app's data folder. They are the same for everyone, so nothing about you is sent
// beyond which tiles are wanted.
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TERRAIN_ZOOM } from '../core/terrain.ts';

/** Downloads at once. */
const AT_ONCE = 6;

export const terrainFile = (dir: string, x: number, y: number) => join(dir, String(TERRAIN_ZOOM), String(x), `${y}.png`);

/**
 * Makes sure the tiles are on disk. Returns how many could not be had: routes
 * there have no elevation.
 */
export async function fetchTerrain(
  dir: string, tiles: [number, number][], get: (x: number, y: number) => Promise<Uint8Array | null>, progress: (done: number, total: number) => void,
): Promise<number> {
  const missing: [number, number][] = [];
  for (const [x, y] of tiles) if (!(await stat(terrainFile(dir, x, y)).then((s) => s.size > 0, () => false))) missing.push([x, y]);
  let done = 0, failed = 0, next = 0;
  progress(0, missing.length);
  const one = async () => {
    while (next < missing.length) {
      const [x, y] = missing[next++]!;
      let data: Uint8Array | null = null;
      for (let tries = 0; tries < 2 && !data; tries++) data = await get(x, y).catch(() => null);
      if (data && data[0] === 0x89 && data[1] === 0x50) {
        const file = terrainFile(dir, x, y);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.part`, data);
        await rename(`${file}.part`, file);
      } else failed++;
      progress(++done, missing.length);
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, one));
  return failed;
}
