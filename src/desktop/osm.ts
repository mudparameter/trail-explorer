// The shared store of OpenStreetMap roads and trails. One copy of each way and
// node, whichever areas use it, so areas that overlap share it. Kept as a graph
// for routes later: ways list their node ids, and ways that meet share a node.
// Nodes have an elevation column, empty until elevation data is added.
import { DatabaseSync } from 'node:sqlite';
import { tilesInBounds, type OsmWay } from '../core/roads.ts';
import { shapeBounds, type Shape } from '../core/shapes.ts';

const toBlob = (ids: number[]) => new Uint8Array(Float64Array.from(ids).buffer);
// Copy first: SQLite's bytes may not be aligned for a Float64Array.
const fromBlob = (b: Uint8Array) => Array.from(new Float64Array(new Uint8Array(b).buffer));

export class OsmStore {
  private db: DatabaseSync;
  /** Tiles already downloaded. */
  private have = new Set<number>();

  constructor(file: string) {
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS node (id INTEGER PRIMARY KEY, lon REAL NOT NULL, lat REAL NOT NULL, ele REAL);
      CREATE TABLE IF NOT EXISTS way (
        id INTEGER PRIMARY KEY, tags TEXT NOT NULL, nodes BLOB NOT NULL,
        w REAL NOT NULL, s REAL NOT NULL, e REAL NOT NULL, n REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS way_box ON way (w, e);
      CREATE TABLE IF NOT EXISTS tile (k INTEGER PRIMARY KEY, fetched_at TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    for (const r of this.db.prepare('SELECT k FROM tile').all() as { k: number }[]) this.have.add(r.k);
  }
  close() {
    this.db.close();
  }

  has(tile: number) {
    return this.have.has(tile);
  }

  private tx(fn: () => void) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Saves ways downloaded for `tiles`, and marks the tiles as done. */
  save(ways: OsmWay[], tiles: number[]) {
    const node = this.db.prepare('INSERT INTO node (id, lon, lat) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET lon = excluded.lon, lat = excluded.lat');
    const way = this.db.prepare('INSERT OR REPLACE INTO way (id, tags, nodes, w, s, e, n) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const tile = this.db.prepare('INSERT OR REPLACE INTO tile (k, fetched_at) VALUES (?, ?)');
    const now = new Date().toISOString();
    this.tx(() => {
      for (const wy of ways) {
        let w = 180, s = 90, e = -180, n = -90;
        wy.coords.forEach(([x, y], i) => {
          node.run(wy.nodes[i]!, x, y);
          w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
        });
        way.run(wy.id, JSON.stringify(wy.tags), toBlob(wy.nodes), w, s, e, n);
      }
      for (const k of tiles) tile.run(k, now);
    });
    for (const k of tiles) this.have.add(k);
  }

  /** Every way that may cross a shape, with its points. */
  waysIn(shape: Shape): OsmWay[] {
    const [w, s, e, n] = shapeBounds(shape);
    const rows = this.db.prepare('SELECT id, tags, nodes FROM way WHERE e >= ? AND w <= ? AND n >= ? AND s <= ?').all(w, e, s, n) as { id: number; tags: string; nodes: Uint8Array }[];
    const ways = rows.map((r) => ({ id: r.id, tags: JSON.parse(r.tags) as Record<string, string>, nodes: fromBlob(r.nodes) }));
    const ids = [...new Set(ways.flatMap((x) => x.nodes))];
    const at = new Map<number, [number, number]>();
    const get = this.db.prepare('SELECT id, lon, lat FROM node WHERE id IN (SELECT value FROM json_each(?))');
    for (let i = 0; i < ids.length; i += 50_000) {
      for (const r of get.all(JSON.stringify(ids.slice(i, i + 50_000))) as { id: number; lon: number; lat: number }[]) at.set(r.id, [r.lon, r.lat]);
    }
    return ways.filter((x) => x.nodes.every((id) => at.has(id))).map((x) => ({ ...x, coords: x.nodes.map((id) => at.get(id)!) }));
  }

  /** Drops every tile not in `keep`, and the ways and nodes only they used. Returns how many ways went. */
  prune(keep: Set<number>): number {
    const drop = [...this.have].filter((k) => !keep.has(k));
    if (!drop.length) return 0;
    const rows = this.db.prepare('SELECT id, w, s, e, n FROM way').all() as { id: number; w: number; s: number; e: number; n: number }[];
    // A way stays while any tile it passes over is kept. Ways too long to check are kept.
    const gone = rows.filter((r) => {
      const ts = tilesInBounds([r.w, r.s, r.e, r.n]);
      return ts.length > 0 && !ts.some((k) => keep.has(k));
    }).map((r) => r.id);
    this.tx(() => {
      const delTile = this.db.prepare('DELETE FROM tile WHERE k = ?');
      for (const k of drop) delTile.run(k);
      this.db.prepare('DELETE FROM way WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(gone));
      // Nodes no way uses any more.
      const used = new Set<number>();
      for (const r of this.db.prepare('SELECT nodes FROM way').all() as { nodes: Uint8Array }[]) for (const id of fromBlob(r.nodes)) used.add(id);
      const all = this.db.prepare('SELECT id FROM node').all() as { id: number }[];
      const unused = all.map((r) => r.id).filter((id) => !used.has(id));
      for (let i = 0; i < unused.length; i += 50_000) {
        this.db.prepare('DELETE FROM node WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(unused.slice(i, i + 50_000)));
      }
    });
    for (const k of drop) this.have.delete(k);
    return gone.length;
  }

  counts(): { ways: number; nodes: number; tiles: number } {
    const n = (t: string) => (this.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { ways: n('way'), nodes: n('node'), tiles: this.have.size };
  }
}
