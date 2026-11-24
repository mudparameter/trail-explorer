// Runs in its own process so the window never freezes.
import { HeatmapBuilder, toGeoJson } from '../core/heatmap.ts';
import { readFile, readRide } from '../core/ride.ts';
import { unpackTrack } from '../core/track.ts';
import { clipTrack, type Zone } from '../core/zones.ts';

process.parentPort.on('message', async ({ data }) => {
  const { id, job, payload } = data;
  try {
    let result: unknown;
    if (job === 'read') result = await readRide(payload);
    else if (job === 'readFile') result = await readFile(payload.name, payload.data);
    else if (job === 'heatmap') {
      const { tracks, zones, options } = payload as { tracks: Float64Array[]; zones: Zone[]; options: ConstructorParameters<typeof HeatmapBuilder>[0] };
      const b = new HeatmapBuilder(options);
      for (const t of tracks) b.addRide(clipTrack(unpackTrack(t), zones));
      const h = b.finish();
      result = { json: toGeoJson(h), focus: h.focus };
    }
    process.parentPort.postMessage({ id, result });
  } catch (e) {
    process.parentPort.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
