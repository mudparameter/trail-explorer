// Runs in its own process so the window never freezes.
import { HeatmapBuilder, toGeoJson } from '../core/heatmap.ts';
import { readRide } from '../core/ride.ts';
import { unpackTrack } from '../core/track.ts';

process.parentPort.on('message', async ({ data }) => {
  const { id, job, payload } = data;
  try {
    let result: unknown;
    if (job === 'read') result = await readRide(payload);
    else if (job === 'heatmap') {
      const b = new HeatmapBuilder();
      for (const t of payload as Float64Array[]) b.addRide(unpackTrack(t));
      const h = b.finish();
      result = { json: toGeoJson(h), focus: h.focus };
    }
    process.parentPort.postMessage({ id, result });
  } catch (e) {
    process.parentPort.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
