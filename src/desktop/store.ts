import { DatabaseSync } from 'node:sqlite';
import type { MapInfo } from '../core/api.ts';
import { activityOf, type Activity } from '../core/activities.ts';
import { SAME_RIDE_MS, startMs } from '../core/import.ts';

/** 'same' is a ride Garmin lists that was already imported from an export: it is never downloaded. */
export type RideStatus = 'waiting' | 'done' | 'no-gps' | 'failed' | 'unread' | 'same';
/** Ids of rides imported from an export start with this. Garmin's are all digits. */
export const IMPORTED = 'file-';

/** All database access. Nothing else imports node:sqlite for the app's own data. */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ride (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, sport TEXT NOT NULL, name TEXT NOT NULL,
        distance REAL, status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, file TEXT, track BLOB);
      CREATE INDEX IF NOT EXISTS ride_status ON ride (status, started_at);
      CREATE TABLE IF NOT EXISTS map (id TEXT PRIMARY KEY, file TEXT NOT NULL, info TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS map_info (k TEXT PRIMARY KEY, info TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setting (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    // Start times as numbers, to find the same ride from different places.
    if (!this.db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('ride', 'start_ms')) {
      this.db.exec('ALTER TABLE ride ADD COLUMN start_ms INTEGER; CREATE INDEX ride_start ON ride (start_ms);');
      const set = this.db.prepare('UPDATE ride SET start_ms = ? WHERE id = ?');
      this.db.exec('BEGIN');
      for (const r of this.db.prepare('SELECT id, started_at FROM ride').all()) set.run(startMs(String(r.started_at)), String(r.id));
      this.db.exec('COMMIT');
    }
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

  /** Adds rides not seen before. Ones already imported from an export are noted but not downloaded. Returns how many are to download. */
  addRides(rides: { id: string; startedAt: string; sport: string; name: string; distance: number | null }[]): number {
    const ins = this.db.prepare('INSERT OR IGNORE INTO ride (id, started_at, sport, name, distance, status, start_ms) VALUES (?, ?, ?, ?, ?, ?, ?)');
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rides) {
        const ms = startMs(r.startedAt);
        const status = ms !== null && this.near(ms, true) ? 'same' : 'waiting';
        const added = Number(ins.run(r.id, r.startedAt, r.sport, r.name, r.distance, status, ms).changes);
        if (status === 'waiting') n += added;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return n;
  }
  /** Is there a ride starting within SAME_RIDE_MS of this? Only imported ones, if `imported`. */
  near(ms: number, imported = false): boolean {
    const q = `SELECT 1 FROM ride WHERE start_ms BETWEEN ? AND ?${imported ? ' AND id LIKE ?' : ''} LIMIT 1`;
    const args = [ms - SAME_RIDE_MS, ms + SAME_RIDE_MS, ...(imported ? [`${IMPORTED}%`] : [])];
    return !!this.db.prepare(q).get(...args);
  }
  has(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM ride WHERE id = ?').get(id);
  }
  /** A ride read from an export. */
  addImported(r: { id: string; startedAt: string; sport: string; name: string; status: RideStatus; file: string | null; track: Float64Array | null }) {
    const blob = r.track ? new Uint8Array(r.track.buffer, r.track.byteOffset, r.track.byteLength) : null;
    this.db.prepare('INSERT OR IGNORE INTO ride (id, started_at, sport, name, distance, status, file, track, start_ms) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)')
      .run(r.id, r.startedAt, r.sport, r.name, r.status, r.file, blob, startMs(r.startedAt));
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
    const out = { waiting: 0, done: 0, 'no-gps': 0, failed: 0, unread: 0, same: 0, total: 0 };
    for (const r of this.db.prepare("SELECT status, count(*) AS n FROM ride WHERE status != 'same' GROUP BY status").all()) {
      out[r.status as RideStatus] = Number(r.n);
      out.total += Number(r.n);
    }
    return out;
  }
  /** Tracks in date order, so the heatmap always comes out the same. Leaves out the kinds of activity in `hide`. */
  tracks(hide: Activity[] = []): Float64Array[] {
    return this.db
      .prepare("SELECT sport, track FROM ride WHERE status = 'done' AND track IS NOT NULL ORDER BY started_at, id")
      .all()
      .filter((r) => !hide.length || !hide.includes(activityOf(String(r.sport))))
      .map((r) => {
        const b = r.track as Uint8Array;
        return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      });
  }
  /** Rides with a track, by kind of activity. */
  activityCounts(): Partial<Record<Activity, number>> {
    const out: Partial<Record<Activity, number>> = {};
    for (const r of this.db.prepare("SELECT sport, count(*) AS n FROM ride WHERE status = 'done' GROUP BY sport").all()) {
      const a = activityOf(String(r.sport));
      out[a] = (out[a] ?? 0) + Number(r.n);
    }
    return out;
  }
  deleteRides() {
    this.db.exec("DELETE FROM ride; DELETE FROM setting WHERE k IN ('lastSync', 'lastSyncStart', 'focus'); VACUUM;");
  }

  /** Maps added before the config folder existed. Only read to move them into it. */
  oldMaps(): { id: string; file: string; info: MapInfo }[] {
    return this.db.prepare('SELECT id, file, info FROM map ORDER BY rowid').all()
      .map((r) => ({ id: String(r.id), file: String(r.file), info: JSON.parse(String(r.info)) as MapInfo }));
  }
  forgetOldMap(id: string) {
    this.db.prepare('DELETE FROM map WHERE id = ?').run(id);
  }

  /** What a map file holds, remembered by its path, size and date, since finding out can be slow. */
  mapInfo(key: string): Omit<MapInfo, 'id' | 'name'> | null {
    const r = this.db.prepare('SELECT info FROM map_info WHERE k = ?').get(key);
    return r ? JSON.parse(String(r.info)) : null;
  }
  saveMapInfo(key: string, info: Omit<MapInfo, 'id' | 'name'>) {
    this.db.prepare('INSERT INTO map_info VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET info = excluded.info').run(key, JSON.stringify(info));
  }
}
