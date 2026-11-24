import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activityOf } from '../src/core/activities.ts';
import { fileText, parseConfig } from '../src/core/config.ts';
import { Store } from '../src/desktop/store.ts';

test('sport names from Garmin, .fit files and exports fall into a few kinds', () => {
  const cases: [string | null, string][] = [
    ['cycling', 'cycling'], ['mountain_biking', 'cycling'], ['road_biking', 'cycling'], ['gravel_cycling', 'cycling'], ['Biking', 'cycling'], ['e_bike_mountain', 'cycling'], ['1', 'cycling'],
    ['running', 'running'], ['trail_running', 'running'], ['9', 'running'],
    ['hiking', 'walking'], ['walking', 'walking'], ['mountaineering', 'walking'], ['casual walking', 'walking'],
    ['alpine_skiing', 'snow'], ['backcountry_snowboarding', 'snow'],
    ['rowing', 'water'], ['stand_up_paddleboarding', 'water'], ['open_water_swimming', 'water'],
    ['golf', 'other'], ['unknown', 'other'], [null, 'other'],
  ];
  for (const [sport, kind] of cases) assert.equal(activityOf(sport), kind, String(sport));
});

test('heatmap.json lists the kinds of activity to hide', () => {
  const read = (hide: unknown) => parseConfig({ 'heatmap.json': JSON.stringify({ hide }) });
  assert.deepEqual(read(['walking', 'running', 'walking']).config.heatmap.hide, ['walking', 'running']);
  const bad = read(['boats']);
  assert.deepEqual(bad.config.heatmap.hide, []);
  assert.match(bad.problems.map((p) => p.message).join(' '), /"hide"/);
  assert.deepEqual(parseConfig({}).config.heatmap.hide, []);
  const c = read(['snow']).config;
  assert.deepEqual(parseConfig({ 'heatmap.json': fileText('heatmap.json', c) }).config.heatmap.hide, ['snow']);
});

test('hidden kinds of activity are left out of the tracks, and counted by kind', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'te-act-')), 'db'));
  const track = new Float64Array([1, 0, 0, 0, 0]);
  for (const [id, sport] of [['a', 'mountain_biking'], ['b', 'cycling'], ['c', 'hiking'], ['d', 'running']] as const) {
    store.addImported({ id, startedAt: `2025-0${id.charCodeAt(0) - 96}-01T00:00:00Z`, sport, name: id, status: 'done', file: null, track });
  }
  store.addImported({ id: 'e', startedAt: '2025-06-01T00:00:00Z', sport: 'walking', name: 'e', status: 'no-gps', file: null, track: null });
  assert.deepEqual(store.activityCounts(), { cycling: 2, walking: 1, running: 1 });
  assert.equal(store.tracks().length, 4);
  assert.equal(store.tracks(['walking', 'running']).length, 2);
  assert.equal(store.tracks(['cycling']).length, 2);
  store.close();
});
