import type { TrailApi } from '../core/api.ts';

/**
 * The app behind the window: the desktop app's main process (put on `window` by
 * its preload script), or the browser backend on the website, set with useTrail
 * before the UI starts.
 */
export let trail = (window as unknown as { trail?: TrailApi }).trail as TrailApi;
export function useTrail(api: TrailApi) {
  trail = api;
}

/**
 * Where bundled files come from: map styles, sprites and fonts. The desktop app
 * serves them as trail://styles/… and so on; the website from one folder, as
 * <base>/styles/…. Always absolute, as the map needs.
 */
let assetBase: string | null = null;
export function useAssets(base: string) {
  assetBase = new URL(base.endsWith('/') ? base : `${base}/`, location.href).href;
}
export const asset = (kind: 'styles' | 'sprites' | 'fonts' | 'heatmap' | 'maps', path: string) =>
  assetBase === null ? `trail://${kind}/${path}` : `${assetBase}${kind}/${path}`;

/** Where the heatmap's GeoJSON is, by version. A file the desktop app serves; on the website, one the backend keeps in memory. */
let heatSource: ((version: number) => string) | null = null;
export function useHeatmapSource(fn: (version: number) => string) {
  heatSource = fn;
}
export const heatmapUrl = (version: number) => (heatSource ? heatSource(version) : asset('heatmap', `heatmap.json?v=${version}`));
