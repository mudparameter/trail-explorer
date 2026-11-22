// Builds one MapLibre style from the layers the user has turned on.
import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl';
import type { LayerState, MapInfo } from '../core/api.ts';

export const HEATMAP = 'heatmap';
export const COLORS = ['#2F6BFF', '#8A3FFC', '#E0369A', '#F0282D', '#FFE14D', '#FFFFFF'];
export const LEGEND = ['1', '2 to 3', '4 to 7', '8 to 15', '16 to 39', '40 or more'];
const FROM = [1, 2, 4, 8, 16, 40];

const OSM = '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>';

/** Default maps. Addresses live only here (and in the CSP in main.ts). */
export const DEFAULT_MAPS: { id: string; name: string; note: string; raster?: SourceSpecification }[] = [
  { id: 'openfreemap', name: 'World map', note: 'OpenFreeMap' },
  {
    id: 'opentopomap', name: 'World topo', note: 'OpenTopoMap',
    raster: {
      type: 'raster', tileSize: 256, maxzoom: 17,
      tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
      attribution: `${OSM}, SRTM | <a href="https://opentopomap.org" target="_blank">© OpenTopoMap</a> (CC-BY-SA)`,
    },
  },
  {
    id: 'ign', name: 'Spain topo', note: 'IGN',
    raster: {
      type: 'raster', tileSize: 256, minzoom: 5, maxzoom: 18, bounds: [-19, 27, 5.5, 44.5],
      tiles: ['https://www.ign.es/wmts/mapa-raster?layer=MTN&style=default&tilematrixset=GoogleMapsCompatible&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/jpeg&TileMatrix={z}&TileCol={x}&TileRow={y}'],
      attribution: '<a href="https://www.ign.es" target="_blank">CC BY 4.0 ign.es</a>',
    },
  },
];

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

export function buildStyle(layers: LayerState[], maps: MapInfo[], bundled: Bundled, heatVersion: number): StyleSpecification {
  const sources: Record<string, SourceSpecification> = {};
  const out: LayerSpecification[] = [{ id: 'paper', type: 'background', paint: { 'background-color': '#eeeeee' } }];
  for (const st of [...layers].reverse()) {
    if (!st.on) continue;
    const k = st.opacity;
    const def = DEFAULT_MAPS.find((d) => d.id === st.id);
    const map = maps.find((m) => m.id === st.id);
    if (st.id === HEATMAP) {
      sources.heatmap = { type: 'geojson', data: `trail://heatmap/heatmap.json?v=${heatVersion}`, tolerance: 0.3, maxzoom: 15 };
      const width = (extra: number): any => ['interpolate', ['linear'], ['zoom'], 2, 1.6 + extra, 9, 2 + extra, 13, 3.5 + extra, 16, 6 + extra, 19, 10 + extra];
      const layout: any = { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'n'] };
      const color: any = ['step', ['get', 'n'], COLORS[0]!, ...FROM.slice(1).flatMap((n, i) => [n, COLORS[i + 1]!])];
      const isLine: any = ['==', ['geometry-type'], 'LineString'];
      out.push(
        {
          // Lines are too small to see from far out, so mark each riding area.
          id: 'heat-dots', type: 'circle', source: 'heatmap', maxzoom: 8, filter: ['==', ['geometry-type'], 'Point'],
          layout: { 'circle-sort-key': ['get', 'n'] },
          paint: {
            'circle-color': color, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3.5, 8, 5], 'circle-stroke-color': '#14141e', 'circle-stroke-width': 1.5,
            'circle-opacity': scale(['interpolate', ['linear'], ['zoom'], 7, 1, 8, 0], k) as any, 'circle-stroke-opacity': scale(['interpolate', ['linear'], ['zoom'], 7, 1, 8, 0], k) as any,
          },
        },
        { id: 'heat-outline', type: 'line', source: 'heatmap', filter: isLine, layout, paint: { 'line-color': '#14141e', 'line-width': width(3), 'line-opacity': 0.9 * k } },
        {
          id: 'heat', type: 'line', source: 'heatmap', filter: isLine, layout,
          paint: { 'line-color': color, 'line-width': width(0), 'line-opacity': k },
        },
      );
    } else if (def?.raster) {
      sources[def.id] = def.raster;
      out.push({ id: def.id, type: 'raster', source: def.id, paint: { 'raster-opacity': k, 'raster-fade-duration': 100 } });
    } else if (def) {
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
  return {
    version: 8,
    glyphs: 'trail://fonts/{fontstack}/{range}.pbf',
    sprite: [{ id: 'default', url: 'trail://sprites/ofm' }, { id: 'base', url: 'trail://sprites/base' }],
    sources,
    layers: out,
  };
}
