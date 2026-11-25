// The website's planning worker, so the page never freezes while routes are
// worked out. The same jobs as the desktop app's worker process.
import { magic, network, routes, setTileReader, type NetworkJob } from '../core/planjobs.ts';
import { terrainTiles } from '../core/terrain.ts';
import { get } from './idb.ts';
import { tileKey } from './terrain.ts';

/** Elevation tiles for the network being planned on, loaded before it is built: planning reads them at once. */
let tiles = new Map<string, Uint8Array>();
setTileReader((_terrain, x, y) => tiles.get(tileKey(x, y)) ?? null);

async function loadTiles(bounds: NetworkJob['bounds']) {
  const next = new Map<string, Uint8Array>();
  for (const [x, y] of terrainTiles(bounds)) {
    const t = await get<Uint8Array>('terrain', tileKey(x, y));
    if (t) next.set(tileKey(x, y), t);
  }
  tiles = next;
  setTileReader((_terrain, x, y) => tiles.get(tileKey(x, y)) ?? null);
}

self.onmessage = async ({ data }: MessageEvent<{ id: number; job: string; payload: any }>) => {
  const { id, job, payload } = data;
  try {
    let result: unknown;
    if (job === 'planNetwork') {
      await loadTiles(payload.bounds);
      result = network(payload);
    } else if (job === 'planRoutes') result = routes(payload);
    else if (job === 'planMagic') result = magic(payload);
    else throw new Error(`Unknown job ${job}.`);
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
