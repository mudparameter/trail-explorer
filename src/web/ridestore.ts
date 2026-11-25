// Rides on the website: read from an export .zip in the browser and kept in its
// database. Nothing is uploaded. Each ride's details are kept in memory; tracks
// are read from the database only when the heatmap or the planner needs them.
import type { Activity } from '../core/activities.ts';
import { activityOf } from '../core/activities.ts';
import { SAME_RIDE_MS } from '../core/import.ts';
import type { RideStore } from '../core/importer.ts';
import { all, clear, get, put } from './idb.ts';

interface Ride {
  id: string;
  startedAt: string;
  startMs: number;
  sport: string;
  name: string;
  status: 'done' | 'no-gps';
}

export class BrowserRideStore implements RideStore {
  private rides = new Map<string, Ride>();
  /** Start times, sorted, for finding the same ride from another source. */
  private starts: number[] = [];

  async open() {
    for (const [, r] of await all<Ride>('rides')) this.rides.set(r.id, r);
    this.starts = [...this.rides.values()].map((r) => r.startMs).sort((a, b) => a - b);
  }

  has(id: string) {
    return this.rides.has(id);
  }

  near(ms: number) {
    // The first start at or after ms - SAME_RIDE_MS.
    let lo = 0, hi = this.starts.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.starts[m]! < ms - SAME_RIDE_MS) lo = m + 1;
      else hi = m;
    }
    return lo < this.starts.length && this.starts[lo]! <= ms + SAME_RIDE_MS;
  }

  async addImported(r: Parameters<RideStore['addImported']>[0]) {
    const ride: Ride = { id: r.id, startedAt: r.startedAt, startMs: Date.parse(r.startedAt), sport: r.sport, name: r.name, status: r.status };
    // The track first: a ride is only listed once its track is safe.
    if (r.track) await put('tracks', [[r.id, r.track.buffer.slice(r.track.byteOffset, r.track.byteOffset + r.track.byteLength)]]);
    await put('rides', [[r.id, ride]]);
    this.rides.set(r.id, ride);
    const i = this.starts.findIndex((s) => s > ride.startMs);
    this.starts.splice(i < 0 ? this.starts.length : i, 0, ride.startMs);
  }

  /** Tracks in date order, so the heatmap always comes out the same. Leaves out the kinds of activity in `hide`. */
  async tracks(hide: Activity[] = []): Promise<Float64Array[]> {
    const want = [...this.rides.values()]
      .filter((r) => r.status === 'done' && !hide.includes(activityOf(r.sport)))
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1));
    const out: Float64Array[] = [];
    for (const r of want) {
      const b = await get<ArrayBuffer>('tracks', r.id);
      if (b) out.push(new Float64Array(b));
    }
    return out;
  }

  counts() {
    let done = 0, noGps = 0;
    for (const r of this.rides.values()) r.status === 'done' ? done++ : noGps++;
    return { done, noGps };
  }

  /** Rides with a track, by kind of activity. */
  activityCounts(): Partial<Record<Activity, number>> {
    const out: Partial<Record<Activity, number>> = {};
    for (const r of this.rides.values()) {
      if (r.status !== 'done') continue;
      const a = activityOf(r.sport);
      out[a] = (out[a] ?? 0) + 1;
    }
    return out;
  }

  async deleteAll() {
    await clear(['rides', 'tracks']);
    this.rides.clear();
    this.starts = [];
  }
}
