// Elevation tiles on the website: downloaded once from the public terrain tiles
// and kept in the browser's database. They are the same for everyone, so nothing
// about you is sent beyond which tiles are wanted.
import { TERRAIN_URL, TERRAIN_ZOOM } from '../core/terrain.ts';
import { have, put } from './idb.ts';

const AT_ONCE = 6;
export const tileKey = (x: number, y: number) => `${TERRAIN_ZOOM}/${x}/${y}`;

/** Makes sure the tiles are stored. Returns how many could not be had: routes there have no elevation. */
export async function fetchTerrain(tiles: [number, number][], progress: (done: number, total: number) => void, base = TERRAIN_URL): Promise<number> {
  const got = await have('terrain', tiles.map(([x, y]) => tileKey(x, y)));
  const missing = tiles.filter(([x, y]) => !got.has(tileKey(x, y)));
  let done = 0, failed = 0, next = 0;
  progress(0, missing.length);
  const one = async () => {
    while (next < missing.length) {
      const [x, y] = missing[next++]!;
      let data: Uint8Array | null = null;
      for (let tries = 0; tries < 2 && !data; tries++) {
        data = await fetch(`${base}/${TERRAIN_ZOOM}/${x}/${y}.png`).then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null), () => null);
      }
      if (data && data[0] === 0x89 && data[1] === 0x50) await put('terrain', [[tileKey(x, y), data]]);
      else failed++;
      progress(++done, missing.length);
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, one));
  return failed;
}
