// Builds one MapLibre style from the config's layers.
import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl';
import type { MapInfo } from '../core/api.ts';
import type { Config } from '../core/config.ts';
import { KINDS, roadsGeoJson, type Road } from '../core/roads.ts';
import { circleRing, zonesGeoJson } from '../core/zones.ts';

export const ZONES = 'zones';
export const ZONE_COLOR = '#d0021b';
/** The circle being drawn. MapView changes its data as the mouse moves. */
export const DRAW = 'draw';
export const AREA_COLOR = '#1d4ed8';
export const ROAD_LINES = 'roads-line';

/** Separates an area's id from a road's key in map features. */
export const KEY_SEP = '|';
/** An area to draw, with the roads to show in it. */
export interface StyleArea {
  id: string;
  center: [number, number];
  radius: number;
  ready: boolean;
  roads: Road[];
}

export interface Bundled {
  liberty: { sources: Record<string, SourceSpecification>; layers: LayerSpecification[] };
  shortbread: { ground: string; layers: LayerSpecification[] };
}

/** Multiplies an opacity value or expression by a number. */
export function scale(v: unknown, k: number): unknown {
  if (v === undefined) return k;
  if (typeof v === 'number') return v * k;
  if (Array.isArray(v)) {
    // Zoom has to stay on the outside of an expression, so scale its outputs.
    if (v[0] === 'interpolate') return v.map((x, i) => (i >= 4 && i % 2 === 0 ? scale(x, k) : x));
    if (v[0] === 'step') return v.map((x, i) => (i >= 2 && i % 2 === 0 ? scale(x, k) : x));
    return ['*', v, k];
  }
  if (v && typeof v === 'object' && Array.isArray((v as any).stops)) {
    return { ...v, stops: (v as any).stops.map(([z, o]: [unknown, unknown]) => [z, scale(o, k)]) };
  }
  return v;
}
const OPACITY: Record<string, string[]> = {
  background: ['background-opacity'], fill: ['fill-opacity'], line: ['line-opacity'], raster: ['raster-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'], symbol: ['text-opacity', 'icon-opacity'],
};
function put(layer: any, prefix: string, opacity: number, source?: string): LayerSpecification {
  const l = { ...layer, id: `${prefix}/${layer.id}` };
  if (l.source) l.source = source ?? `${prefix}/${l.source}`;
  if (opacity < 1) {
    l.paint = { ...l.paint };
    for (const p of OPACITY[l.type] ?? []) l.paint[p] = scale(l.paint[p], opacity);
  }
  return l;
}

const ROAD_WIDTHS: [number, number][] = [[10, 1.5], [14, 3], [18, 6]];
/**
 * Line widths by zoom, as [zoom, width] stops, scaled by a layer's width setting.
 * `extra` is for an outline: it thins with thin lines but doesn't grow with thick ones.
 */
function widths(stops: [number, number][], scale = 1) {
  return (extra: number): any => {
    const e = extra * Math.min(1, Math.sqrt(scale));
    return ['interpolate', ['linear'], ['zoom'], ...stops.flatMap(([z, x]) => [z, x * scale + e])];
  };
}

export interface StyleInput {
  config: Config;
  /** Map files that could be read, by layer id. */
  maps: Record<string, MapInfo>;
  bundled: Bundled;
  heatVersion: number;
  /** Draw the excluded zones on top. Only for the desktop app: on a website they would show where you live. */
  showZones: boolean;
  /** Clicks are drawing a circle. */
  drawing?: boolean;
  areas?: StyleArea[];
  /** The selected road, as area id + KEY_SEP + road key. */
  selected?: string | null;
}

export function buildStyle({ config, maps, bundled, heatVersion, showZones, drawing, areas = [], selected = null }: StyleInput): StyleSpecification {
  const sources: Record<string, SourceSpecification> = {};
  const out: LayerSpecification[] = [{ id: 'paper', type: 'background', paint: { 'background-color': config.map.background } }];
  const { bands, outline } = config.heatmap;
  const roadColor: any = ['match', ['get', 'kind'], ...KINDS.flatMap((k) => [k.kind, k.color]), '#000000'];
  const dim: any = selected ? ['case', ['==', ['get', 'key'], selected], 1, 0.35] : 1;
  const roadLayout: any = { 'line-cap': 'round', 'line-join': 'round' };
  for (const def of [...config.layers].reverse()) {
    if (!def.on) continue;
    const k = def.opacity;
    const map = def.type === 'file' ? maps[def.id] : undefined;
    if (def.type === 'heatmap') {
      sources.heatmap = { type: 'geojson', data: `trail://heatmap/heatmap.json?v=${heatVersion}`, tolerance: 0.3, maxzoom: 15 };
      const width = widths([[2, 1.6], [9, 2], [13, 3.5], [16, 6], [19, 10]], def.width);
      const layout: any = { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'n'] };
      const color: any = bands.length > 1 ? ['step', ['get', 'n'], bands[0]!.color, ...bands.slice(1).flatMap((b) => [b.from, b.color])] : bands[0]!.color;
      const isLine: any = ['==', ['geometry-type'], 'LineString'];
      out.push(
        {
          // Lines are too small to see from far out, so mark each riding area.
          id: 'heat-dots', type: 'circle', source: 'heatmap', maxzoom: 8, filter: ['==', ['geometry-type'], 'Point'],
          layout: { 'circle-sort-key': ['get', 'n'] },
          paint: {
            'circle-color': color, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3.5, 8, 5], 'circle-stroke-color': outline, 'circle-stroke-width': 1.5,
            'circle-opacity': scale(['interpolate', ['linear'], ['zoom'], 7, 1, 8, 0], k) as any, 'circle-stroke-opacity': scale(['interpolate', ['linear'], ['zoom'], 7, 1, 8, 0], k) as any,
          },
        },
        { id: 'heat-outline', type: 'line', source: 'heatmap', filter: isLine, layout, paint: { 'line-color': outline, 'line-width': width(3), 'line-opacity': 0.9 * k } },
        {
          id: 'heat', type: 'line', source: 'heatmap', filter: isLine, layout,
          paint: { 'line-color': color, 'line-width': width(0), 'line-opacity': k },
        },
      );
    } else if (def.type === 'roads') {
      if (!areas.length) continue;
      // Dashed, and normally under your rides: what you have ridden shows in ride
      // colours on top, and only what you haven't stays dashed.
      const width = widths(ROAD_WIDTHS, def.width);
      out.push(
        { id: 'roads-casing', type: 'line', source: 'roads', layout: roadLayout, paint: { 'line-color': '#ffffff', 'line-width': width(2), 'line-opacity': ['*', 0.8 * k, dim] } },
        { id: ROAD_LINES, type: 'line', source: 'roads', layout: { 'line-join': 'round' }, paint: { 'line-color': roadColor, 'line-width': width(0), 'line-opacity': ['*', k, dim], 'line-dasharray': [2, 1.5] } },
      );
    } else if (def.type === 'raster') {
      const { tiles, tileSize, minzoom, maxzoom, bounds, attribution } = def;
      sources[def.id] = { type: 'raster', tiles, tileSize, minzoom, maxzoom, ...(bounds ? { bounds } : {}), attribution };
      out.push({ id: def.id, type: 'raster', source: def.id, paint: { 'raster-opacity': k, 'raster-fade-duration': 100 } });
    } else if (def.type === 'openfreemap') {
      for (const [n, s] of Object.entries(bundled.liberty.sources)) sources[`${def.id}/${n}`] = s;
      for (const l of bundled.liberty.layers) out.push(put(l, def.id, k));
    } else if (map) {
      const src = `map/${map.id}`;
      const tiles = [`trail://maps/${map.id}/{z}/{x}/{y}`];
      const common = { tiles, bounds: map.bounds, minzoom: map.minzoom, maxzoom: map.maxzoom, attribution: map.attribution };
      if (map.kind === 'raster') {
        sources[src] = { type: 'raster', tileSize: 256, ...common };
        out.push({ id: src, type: 'raster', source: src, paint: { 'raster-opacity': k } });
        continue;
      }
      sources[src] = { type: 'vector', ...common };
      if (map.kind === 'shortbread') {
        // Ground colour for the map's own area only, so other maps show around it.
        const [w, s, e, n] = map.bounds;
        sources[`${src}/area`] = {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } },
        };
        // BBBike tiles for far-out views spill well beyond the map's area, so
        // start drawing once the area is a reasonable size on screen.
        const near = Math.max(0, Math.floor(Math.log2(360 / (e - w))) - 1);
        out.push({ id: `${src}/ground`, type: 'fill', minzoom: near, source: `${src}/area`, paint: { 'fill-color': bundled.shortbread.ground, 'fill-opacity': k, 'fill-antialias': false } });
        for (const l of bundled.shortbread.layers) {
          if ((l.maxzoom ?? 24) > near) out.push({ ...put(l, src, k, src), minzoom: Math.max(l.minzoom ?? 0, near) } as LayerSpecification);
        }
      } else {
        for (const id of map.layers) {
          const base = { source: src, 'source-layer': id };
          out.push(
            { ...base, id: `${src}/${id}/fill`, type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#7a9a7a', 'fill-opacity': 0.15 * k } },
            { ...base, id: `${src}/${id}/line`, type: 'line', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#555555', 'line-width': 1, 'line-opacity': k } },
          );
        }
      }
    }
  }
  if (showZones && config.zones.length) {
    sources[ZONES] = { type: 'geojson', data: zonesGeoJson(config.zones) };
    out.push(
      { id: 'zones-fill', type: 'fill', source: ZONES, paint: { 'fill-color': ZONE_COLOR, 'fill-opacity': 0.12 } },
      { id: 'zones-line', type: 'line', source: ZONES, paint: { 'line-color': ZONE_COLOR, 'line-width': 2, 'line-dasharray': [2, 1.5] } },
    );
  }
  if (areas.length) {
    sources['roads-area'] = {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: areas.map((a) => ({ type: 'Feature', properties: { id: a.id, ready: a.ready }, geometry: { type: 'Polygon', coordinates: [circleRing(a.center, a.radius, 120)] } })),
      },
    };
    sources.roads = {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: areas.flatMap((a) => roadsGeoJson(a.roads, a.id + KEY_SEP).features) },
      tolerance: 0.2,
      attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>',
    };
    // The circles stay on top, even with road lines off or moved down.
    out.push(
      { id: 'roads-area-fill', type: 'fill', source: 'roads-area', paint: { 'fill-color': AREA_COLOR, 'fill-opacity': ['case', ['get', 'ready'], 0.05, 0.12] } },
      // Areas still downloading have a fainter, finer edge.
      { id: 'roads-area-line', type: 'line', source: 'roads-area', paint: { 'line-color': AREA_COLOR, 'line-width': ['case', ['get', 'ready'], 2, 1.5], 'line-opacity': ['case', ['get', 'ready'], 1, 0.6], 'line-dasharray': [3, 2] } },
    );
    if (selected) {
      const only: any = ['==', ['get', 'key'], selected];
      const width = widths(ROAD_WIDTHS, config.layers.find((l) => l.type === 'roads')?.width);
      out.push(
        { id: 'roads-selected-halo', type: 'line', source: 'roads', filter: only, layout: roadLayout, paint: { 'line-color': '#facc15', 'line-width': width(8) } },
        { id: 'roads-selected', type: 'line', source: 'roads', filter: only, layout: roadLayout, paint: { 'line-color': roadColor, 'line-width': width(2) } },
      );
    }
  }
  if (drawing) {
    sources[DRAW] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
    out.push(
      { id: 'draw-fill', type: 'fill', source: DRAW, paint: { 'fill-color': AREA_COLOR, 'fill-opacity': 0.1 } },
      { id: 'draw-line', type: 'line', source: DRAW, paint: { 'line-color': AREA_COLOR, 'line-width': 2 } },
    );
  }
  return {
    version: 8,
    glyphs: 'trail://fonts/{fontstack}/{range}.pbf',
    sprite: [{ id: 'default', url: 'trail://sprites/ofm' }, { id: 'base', url: 'trail://sprites/base' }],
    sources,
    layers: out,
  };
}
