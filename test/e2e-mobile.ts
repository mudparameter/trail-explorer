// Drives the website build (out/web) at phone size, with touch: the map fills
// the screen, the tabs along the bottom open each part as a sheet, an area is
// drawn with two taps, and the route planner's steps fold away for tapping the
// map. Then the window is widened and the desktop layout comes back.
// Run: npm run build:web && SHOTS=folder node test/e2e-mobile.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserData, closeServers, launch, MID, Q } from './web-servers.ts';

const shots = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), 'te-shots-'));
const app = await launch(browserData(), '390x844');
const w = await app.firstWindow();
const logs: string[] = [];
w.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
w.on('pageerror', (e) => logs.push('PAGE ' + e.message));
const shot = (n: string) => w.screenshot({ path: join(shots, `m${n}.png`) });
// A touch screen: the page sees a coarse pointer, and the map is tapped with touch events.
const cdp = await w.context().newCDPSession(w);
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
/** Taps a place on the map with a finger. */
const tapAt = async (mapName: '__map' | '__planMap', at: [number, number]) => {
  const box = (await w.locator('.map').first().boundingBox())!;
  const p = await w.evaluate(([n, x, y]) => (window as any)[n].project([x, y]), [mapName, at[0], at[1]] as const);
  const point = { x: box.x + p.x, y: box.y + p.y };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await w.waitForTimeout(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await w.waitForTimeout(350);
};
const tab = (name: string) => w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();
/** Nothing in the open sheet is wider than the phone. */
const fits = async (what: string) => {
  const [scroll, client] = await w.locator('.sheet-body').evaluate((el) => [el.scrollWidth, el.clientWidth]);
  assert.ok(scroll <= client + 1, `${what} fits the width (${scroll} > ${client})`);
};

try {
  // The map fills the screen, with tabs along the bottom and no sidebar.
  await w.getByRole('navigation', { name: 'Main' }).waitFor({ timeout: 30000 });
  await w.waitForFunction(() => (window as any).__map?.isStyleLoaded?.(), null, { timeout: 30000 });
  assert.equal(await w.locator('.side').count(), 0, 'no sidebar on a phone');
  const map = (await w.locator('.map').boundingBox())!;
  assert.ok(map.width >= 388 && map.height > 600, `the map fills the screen (${map.width}×${map.height})`);
  assert.ok(await w.evaluate(() => matchMedia('(pointer: coarse)').matches), 'touch');
  assert.equal(await w.locator('.maplibregl-ctrl-geolocate').count(), 1, 'a button for where you are');
  await shot('1-map');

  // Rides and layers, in a sheet.
  await tab('Layers');
  await w.locator('.sheet-head h1').getByText('Rides and layers').waitFor();
  await w.getByRole('button', { name: 'Import rides…' }).waitFor();
  await w.getByText('0 rides on the map').waitFor();
  await fits('Layers');
  await shot('2-layers');
  await w.getByRole('button', { name: 'Done' }).click();
  await w.locator('.sheet').waitFor({ state: 'detached' });

  // Draw an area with two taps: the sheet gets out of the way.
  await w.evaluate(([x, y]) => (window as any).__map.jumpTo({ center: [x, y], zoom: 13 }), MID);
  await tab('Areas');
  await fits('Areas');
  await w.getByRole('button', { name: 'Draw a circle' }).click();
  await w.locator('.sheet').waitFor({ state: 'detached' });
  await w.getByText('Tap the centre of the area to search.').waitFor();
  await tapAt('__map', MID);
  await w.getByText('Now tap the edge of the area to finish.').waitFor();
  await shot('3-first-tap');
  await tapAt('__map', Q(1400, 0));
  await tab('Areas');
  await w.locator('.areas > li').first().getByText(/trails/).waitFor({ timeout: 30000 });
  await shot('4-areas');

  // Roads in the area: a panel along the bottom of the map.
  await w.locator('.areas > li').first().getByRole('button', { name: /Details of/ }).click();
  await w.getByRole('button', { name: 'List roads and trails' }).click();
  await w.locator('.sheet').waitFor({ state: 'detached' });
  const roads = (await w.locator('.roads').boundingBox())!;
  assert.ok(roads.x >= 0 && roads.x + roads.width <= 390 && roads.y > 300, 'the roads panel is along the bottom');
  await shot('5-roads');
  await w.getByRole('button', { name: 'Close the list' }).click();

  // The route planner: tapping the map folds the steps away; placing the start brings them back.
  await tab('Areas');
  await w.getByRole('button', { name: 'Route planner →' }).click();
  await w.getByRole('button', { name: 'Use these areas' }).click();
  await w.locator('.notice').getByText('Tap the map to place the start.').waitFor({ timeout: 30000 });
  await w.locator('.plan-side.collapsed').waitFor();
  await w.waitForTimeout(500);
  await shot('6-place-start');
  await tapAt('__planMap', Q(-200, -150));
  await w.locator('.plan-side.collapsed').waitFor({ state: 'detached' });
  await w.getByLabel('Distance', { exact: true }).fill('6');
  await w.getByRole('button', { name: 'Plan routes' }).click();
  await w.locator('.route-card').nth(1).waitFor({ timeout: 60000 });
  await w.waitForTimeout(400);
  await shot('7-routes');
  // Folding the steps gives the map more room.
  const before = (await w.locator('.map').boundingBox())!.height;
  await w.locator('.sheet-toggle').click();
  await w.waitForTimeout(300);
  assert.ok((await w.locator('.map').boundingBox())!.height > before + 100, 'more map with the steps folded');
  await w.locator('.sheet-toggle').click();
  await w.locator('.route-card').first().getByRole('button', { name: 'Save…' }).click();
  await w.getByLabel('Route name').fill('Phone loop');
  await w.locator('.route-card').first().getByRole('button', { name: 'Save', exact: true }).click();
  await w.getByText('Saved as “Phone loop”.').waitFor();
  await w.getByRole('button', { name: 'Saved routes' }).click();

  // Saved routes: a card each, and a way to sort without column headings.
  await w.locator('.sheet-head h1').getByText('Saved routes').waitFor();
  await w.getByText('Phone loop').first().waitFor();
  await w.getByLabel('Sort by').waitFor({ state: 'detached' }); // one route: nothing to sort
  assert.equal(await w.locator('table.routes thead').isVisible(), false);
  await fits('Saved routes');
  await w.getByRole('button', { name: 'Phone loop' }).click();
  await w.locator('.route-view .map').waitFor();
  await fits('A saved route');
  await shot('8-saved');

  // More: Customize, Settings and Help, each with a way back.
  await tab('More');
  await w.getByRole('button', { name: /^Customize/ }).click();
  await w.getByRole('button', { name: 'Export config (.zip)' }).waitFor();
  await fits('Customize');
  await shot('9-customize');
  await w.getByRole('button', { name: '‹ More' }).click();
  await w.getByRole('button', { name: /^Help/ }).click();
  await w.getByText('Plan a route').first().waitFor();
  await fits('Help');
  await w.getByRole('button', { name: '‹ More' }).click();
  await w.getByRole('button', { name: /^Settings/ }).click();
  await w.getByRole('button', { name: 'Import rides from a .zip' }).waitFor();
  await fits('Settings');
  // Tapping the open tab again goes back to the map.
  await tab('More');
  await w.locator('.sheet').waitFor({ state: 'detached' });

  // Wider: the sidebar is back, and the tabs are gone.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 860));
  await w.locator('.side').waitFor();
  assert.equal(await w.locator('.tabbar').count(), 0);
  await w.getByRole('heading', { name: 'Roads and trails' }).waitFor();
  await shot('10-wide');

  const bad = logs.filter((l) => !/Failed to load resource|could not be loaded|Expected value to be of type number/.test(l));
  if (bad.length) console.log('page errors:', bad);
  assert.equal(bad.length, 0, 'no page errors');
  console.log('Mobile E2E passed. Screenshots in', shots);
} finally {
  await app.close().catch(() => {});
  closeServers();
}
