// The route planner's map: the chosen areas, every path in them (ridden or
// not), routes, and the start and finish. A faded base map can go underneath.
import type { FeatureCollection } from 'geojson';
import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl';
import type { MapInfo } from '../core/api.ts';
import type { Config } from '../core/config.ts';
import type { Circle } from '../core/network.ts';
import { KINDS } from '../core/roads.ts';
import { buildStyle, circleFeatures, circleLineLayout, circleLinePaint, type Bundled } from './mapstyle.ts';

/** One colour per route, in the order they are listed. */
export const ROUTE_COLORS = ['#e11d48', '#7c3aed', '#0891b2', '#ca8a04', '#16a34a'];
export const RIDDEN_COLOR = '#2563eb';
export const RIDDEN_DARK = '#27272a';
/** Paths you have ridden: highlighted in blue, darkened, coloured like the heatmap by times ridden, or drawn like any other path. */
export type RiddenLook = 'show' | 'dark' | 'heatmap' | 'hide';
export const START_COLOR = '#16a34a';
export const FINISH_COLOR = '#dc2626';
/** Where the mouse is on the elevation profile. */
export const HOVER = 'hover';
export const NETWORK_LINES = 'net-line';

export interface PlanRoute {
  id: string;
  line: [number, number, number][];
}

export interface PlanStyleInput {
  config: Config;
  maps: Record<string, MapInfo>;
  bundled: Bundled;
  baseMap: boolean;
  /** How paths you have ridden look. Normally highlighted. */
  ridden?: RiddenLook;
  circles: Circle[];
  network: FeatureCollection | null;
  routes: PlanRoute[];
  selected: string | null;
  start: [number, number] | null;
  finish: [number, number] | null;
}

/** Ridden paths in the heatmap's colours by times ridden, with its outline, most ridden on top. */
function heatLayers(config: Config, width: (w: number) => any, round: any, faded: number): LayerSpecification[] {
  const { bands, outline } = config.heatmap;
  const color: any = bands.length > 1 ? ['step', ['get', 'passes'], bands[0]!.color, ...bands.slice(1).flatMap((b) => [b.from, b.color])] : bands[0]!.color;
  const filter: any = ['all', ['get', 'ridden'], ['!', ['get', 'restricted']]];
  const layout = { ...round, 'line-sort-key': ['get', 'passes'] };
  return [
    { id: 'net-ridden-outline', type: 'line', source: 'net', filter, layout, paint: { 'line-color': outline, 'line-width': width(4.5), 'line-opacity': 0.9 * faded } },
    { id: 'net-ridden', type: 'line', source: 'net', filter, layout, paint: { 'line-color': color, 'line-width': width(3), 'line-opacity': faded } },
  ];
}

export function planStyle(p: PlanStyleInput): StyleSpecification {
  // The base map is the main map's own layers, without rides or roads, and faded.
  const base = buildStyle({
    config: {
      ...p.config,
      layers: p.baseMap ? p.config.layers.filter((l) => l.type !== 'heatmap' && l.type !== 'roads').map((l) => ({ ...l, opacity: l.opacity * 0.45 })) : [],
      zones: [],
    },
    maps: p.maps, bundled: p.bundled, heatVersion: 0, showZones: false,
  });
  const sources: Record<string, SourceSpecification> = { ...base.sources };
  const layers: LayerSpecification[] = [...base.layers];
  const round: any = { 'line-cap': 'round', 'line-join': 'round' };
  const width = (w: number): any => ['interpolate', ['linear'], ['zoom'], 10, w * 0.6, 14, w, 18, w * 2];
  /** Wider for the selected route. Zoom must be the outer expression. */
  const routeWidth = (on: number, off: number): any => ['interpolate', ['linear'], ['zoom'], ...[[10, 0.6], [14, 1], [18, 2]].flatMap(([z, k]) => [z, ['case', ['get', 'on'], on * k!, off * k!]])];

  // Routes can go anywhere in the chosen circles, so they are drawn as one area.
  const shapes = circleFeatures([{ id: 'plan', circles: p.circles }]);
  const line = p.config.map.circles;
  sources.areas = { type: 'geojson', data: shapes.fill };
  sources['areas-edge'] = { type: 'geojson', data: shapes.edge };
  layers.push(
    { id: 'area-fill', type: 'fill', source: 'areas', paint: { 'fill-color': line.color, 'fill-opacity': 0.04 } },
    { id: 'area-line', type: 'line', source: 'areas-edge', layout: circleLineLayout(line), paint: circleLinePaint(line) },
  );
  if (p.network) {
    sources.net = { type: 'geojson', data: p.network, tolerance: 0.3 };
    const kind: any = ['match', ['get', 'kind'], ...KINDS.flatMap((k) => [k.kind, k.color]), '#000'];
    const faded = p.routes.length ? 0.45 : 1;
    layers.push(
      // Restricted: thin and grey. Ridden: solid blue. Not ridden yet: dashed, coloured by kind.
      { id: 'net-restricted', type: 'line', source: 'net', filter: ['get', 'restricted'], layout: round, paint: { 'line-color': '#9ca3af', 'line-width': width(1.5), 'line-dasharray': [1, 2], 'line-opacity': faded } },
      ...(p.ridden === 'hide' ? [] : p.ridden === 'heatmap' ? heatLayers(p.config, width, round, faded) : [{
        id: 'net-ridden', type: 'line', source: 'net', filter: ['all', ['get', 'ridden'], ['!', ['get', 'restricted']]], layout: round,
        paint: p.ridden === 'dark'
          ? { 'line-color': RIDDEN_DARK, 'line-width': width(2), 'line-opacity': 0.75 * faded }
          : { 'line-color': RIDDEN_COLOR, 'line-width': width(3), 'line-opacity': 0.8 * faded },
      } as LayerSpecification]),
      // With ridden paths hidden, they are drawn like any other path: only the ridden look goes.
      { id: NETWORK_LINES, type: 'line', source: 'net', filter: p.ridden === 'hide' ? ['!', ['get', 'restricted']] : ['all', ['!', ['get', 'ridden']], ['!', ['get', 'restricted']]], layout: { 'line-join': 'round' }, paint: { 'line-color': kind, 'line-width': width(2.5), 'line-dasharray': [2, 1.5], 'line-opacity': faded } },
    );
  }
  const shown = p.selected ? [...p.routes.filter((r) => r.id !== p.selected), ...p.routes.filter((r) => r.id === p.selected)] : p.routes;
  sources.routes = {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: shown.map((r) => ({
        type: 'Feature', properties: { id: r.id, color: ROUTE_COLORS[p.routes.indexOf(r) % ROUTE_COLORS.length], on: r.id === p.selected },
        geometry: { type: 'LineString', coordinates: r.line.map(([x, y]) => [x, y]) },
      })),
    },
  };
  const dim = p.selected ? ['case', ['get', 'on'], 1, 0.35] : 0.9;
  layers.push(
    { id: 'route-casing', type: 'line', source: 'routes', layout: round, paint: { 'line-color': '#fff', 'line-width': routeWidth(9, 5), 'line-opacity': dim as any } },
    { id: 'route-line', type: 'line', source: 'routes', layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': routeWidth(6, 3), 'line-opacity': dim as any } },
  );
  const points = [
    ...(p.start ? [{ at: p.start, color: START_COLOR }] : []),
    ...(p.finish ? [{ at: p.finish, color: FINISH_COLOR }] : []),
  ];
  sources.points = { type: 'geojson', data: { type: 'FeatureCollection', features: points.map((x) => ({ type: 'Feature', properties: { color: x.color }, geometry: { type: 'Point', coordinates: x.at } })) } };
  sources[HOVER] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  layers.push(
    { id: 'points', type: 'circle', source: 'points', paint: { 'circle-radius': 8, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } },
    { id: HOVER, type: 'circle', source: HOVER, paint: { 'circle-radius': 6, 'circle-color': '#111', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },
  );
  return { ...base, sources, layers };
}
