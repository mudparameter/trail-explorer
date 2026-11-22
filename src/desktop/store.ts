import { DatabaseSync } from 'node:sqlite';
import type { MapInfo } from '../core/api.ts';

export type RideStatus = 'waiting' | 'done' | 'no-gps' | 'failed' | 'unread';

/** All database access. Nothing else imports node:sqlite for the app's own data. */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ride (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, sport TEXT NOT NULL, name TEXT NOT NULL,
        distance REAL, status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, file TEXT, track BLOB);
      CREATE INDEX IF NOT EXISTS ride_status ON ride (status, started_at);
      CREATE TABLE IF NOT EXISTS map (id TEXT PRIMARY KEY, file TEXT NOT NULL, info TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setting (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
  }
  close() {
    this.db.close();
  }

  get<T>(k: string): T | null {
    const row = this.db.prepare('SELECT v FROM setting WHERE k = ?').get(k) as { v: string } | undefined;
    return row ? (JSON.parse(row.v) as T) : null;
  }
  set(k: string, v: unknown) {
    if (v == null) this.db.prepare('DELETE FROM setting WHERE k = ?').run(k);
    else this.db.prepare('INSERT INTO setting VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
  }

  /** Adds rides not seen before. Returns how many were new. */
  addRides(rides: { id: string; startedAt: string; sport: string; name: string; distance: number | null }[]): number {
    const ins = this.db.prepare("INSERT OR IGNORE INTO ride (id, started_at, sport, name, distance, status) VALUES (?, ?, ?, ?, ?, 'waiting')");
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rides) n += Number(ins.run(r.id, r.startedAt, r.sport, r.name, r.distance).changes);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return n;
  }
  nextWaiting(): { id: string; tries: number } | null {
    const r = this.db.prepare("SELECT id, tries FROM ride WHERE status = 'waiting' ORDER BY tries, started_at DESC LIMIT 1").get();
    return r ? { id: String(r.id), tries: Number(r.tries) } : null;
  }
  finishRide(id: string, status: RideStatus, file: string | null, track: Float64Array | null) {
    const blob = track ? new Uint8Array(track.buffer, track.byteOffset, track.byteLength) : null;
    this.db.prepare('UPDATE ride SET status = ?, file = ?, track = ? WHERE id = ?').run(status, file, blob, id);
  }
  countTry(id: string) {
    this.db.prepare('UPDATE ride SET tries = tries + 1 WHERE id = ?').run(id);
  }
  retryFailed() {
    this.db.prepare("UPDATE ride SET status = 'waiting', tries = 0 WHERE status IN ('failed', 'waiting')").run();
  }
  counts(): Record<RideStatus, number> & { total: number } {
    const out = { waiting: 0, done: 0, 'no-gps': 0, failed: 0, unread: 0, total: 0 };
    for (const r of this.db.prepare('SELECT status, count(*) AS n FROM ride GROUP BY status').all()) {
      out[r.status as RideStatus] = Number(r.n);
      out.total += Number(r.n);
    }
    return out;
  }
  /** Tracks in date order, so the heatmap always comes out the same. */
  tracks(): Float64Array[] {
    return this.db
      .prepare("SELECT track FROM ride WHERE status = 'done' AND track IS NOT NULL ORDER BY started_at, id")
      .all()
      .map((r) => {
        const b = r.track as Uint8Array;
        return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      });
  }
  deleteRides() {
    this.db.exec("DELETE FROM ride; DELETE FROM setting WHERE k IN ('lastSync', 'lastSyncStart', 'focus'); VACUUM;");
  }

  maps(): { id: string; file: string; info: MapInfo }[] {
    return this.db.prepare('SELECT id, file, info FROM map ORDER BY rowid').all()
      .map((r) => ({ id: String(r.id), file: String(r.file), info: JSON.parse(String(r.info)) as MapInfo }));
  }
  saveMap(file: string, info: MapInfo) {
    this.db.prepare('INSERT INTO map VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET info = excluded.info').run(info.id, file, JSON.stringify(info));
  }
  removeMap(id: string) {
    this.db.prepare('DELETE FROM map WHERE id = ?').run(id);
  }
}
