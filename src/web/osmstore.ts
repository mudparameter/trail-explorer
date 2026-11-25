// Downloaded road data on the website. The download manager reads it at once, so
// it is all kept in memory, and each download is also saved to the browser's
// database so it survives a reload. Overlapping areas share it, as on the desktop.
import type { WayStore } from '../core/areadata.ts';
import { tilesInBounds, type OsmWay } from '../core/roads.ts';
import { shapeBounds, type Shape } from '../core/shapes.ts';
import type { Bounds } from '../core/api.ts';
import { all, put } from './idb.ts';

/** One download as saved: the tiles it covered, and the ways it brought. */
interface Batch {
  tiles: number[];
  ways: OsmWay[];
}

export class BrowserWayStore implements WayStore {
  private ways = new Map<number, { way: OsmWay; box: Bounds }>();
  private tiles = new Set<number>();
  private batches = new Map<IDBValidKey, Batch>();

  /** Loads what earlier visits downloaded. */
  async open() {
    for (const [k, b] of await all<Batch>('osm')) {
      this.batches.set(k, b);
      this.add(b);
    }
  }

  private add(b: Batch) {
    for (const t of b.tiles) this.tiles.add(t);
    for (const w of b.ways) {
      let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
      for (const [x, y] of w.coords) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      this.ways.set(w.id, { way: w, box: [x0, y0, x1, y1] });
    }
  }

  has(tile: number) {
    return this.tiles.has(tile);
  }

  save(ways: OsmWay[], tiles: number[]) {
    const b: Batch = { tiles: [...tiles], ways };
    this.add(b);
    put('osm', [[null, b]]).then(([k]) => this.batches.set(k!, b)).catch((e) => console.error('Could not keep road data:', e));
  }

  waysIn(shape: Shape): OsmWay[] {
    const [w, s, e, n] = shapeBounds(shape);
    const out: OsmWay[] = [];
    for (const { way, box } of this.ways.values()) if (box[2] >= w && box[0] <= e && box[3] >= s && box[1] <= n) out.push(way);
    return out;
  }

  prune(keep: Set<number>): number {
    const drop = [...this.tiles].filter((k) => !keep.has(k));
    if (!drop.length) return 0;
    for (const k of drop) this.tiles.delete(k);
    // A way stays while any tile it passes over is kept. Ways too long to check are kept.
    let gone = 0;
    for (const [id, { box }] of this.ways) {
      const ts = tilesInBounds(box);
      if (ts.length > 0 && !ts.some((k) => keep.has(k))) {
        this.ways.delete(id);
        gone++;
      }
    }
    // Saved downloads: drop those with no tile left, and keep only the kept tiles of the rest.
    const changes: [IDBValidKey, Batch | undefined][] = [];
    for (const [key, b] of this.batches) {
      const tiles = b.tiles.filter((t) => keep.has(t));
      if (tiles.length === b.tiles.length) continue;
      const next = tiles.length ? { tiles, ways: b.ways.filter((w) => this.ways.has(w.id)) } : undefined;
      if (next) this.batches.set(key, next);
      else this.batches.delete(key);
      changes.push([key, next]);
    }
    if (changes.length) put('osm', changes).catch((e) => console.error('Could not tidy road data:', e));
    return gone;
  }
}
