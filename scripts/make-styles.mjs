// Writes the bundled map styles in resources/styles. Run again only to update them:
//   node scripts/make-styles.mjs
import { writeFile } from 'node:fs/promises';
import { osm } from '@versatiles/style';

const out = new URL('../resources/styles/', import.meta.url);
const fonts = {
  'Noto Sans Regular': 'noto_sans_regular',
  'Noto Sans Bold': 'noto_sans_bold',
  'Noto Sans Italic': 'noto_sans_regular_italic',
};
const rename = (v) =>
  Array.isArray(v) ? v.map(rename) : typeof v === 'string' ? (fonts[v] ?? v) : v;

// Custom maps in Shortbread format (BBBike).
const sb = osm({ projection: 'mercator' });
const ground = sb.layers.find((l) => l.type === 'background');
// The stock style draws trails almost invisibly. This is a trail app, so make them stand out.
const TRAIL = { path: '#8a4b1f', footway: '#8a4b1f', steps: '#8a4b1f', cycleway: '#2f6f4f', track: '#8a5a2b' };
for (const l of sb.layers) {
  const kind = l.id.match(/(?:way|street)-(path|footway|steps|cycleway|track)(:outline)?$/);
  if (!kind || l.type !== 'line') continue;
  if (kind[2]) {
    l.layout = { ...l.layout, visibility: 'none' };
    continue;
  }
  l.paint = {
    ...l.paint,
    'line-color': TRAIL[kind[1]],
    'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 15, 1.6, 18, 3, 20, 5],
    'line-opacity': l.id.startsWith('tunnel') ? 0.4 : 0.9,
    'line-dasharray': kind[1] === 'track' ? [5, 1.5] : [2.5, 1.2],
  };
  delete l.paint['line-gap-width'];
  l.layout = { ...l.layout, 'line-cap': 'butt' };
}
await writeFile(new URL('shortbread.json', out), JSON.stringify({
  ground: ground?.paint?.['background-color'] ?? '#f9f4ee',
  layers: sb.layers.filter((l) => l.type !== 'background' && l.type !== 'fill-extrusion' && l.source === 'versatiles-shortbread'),
}));

// Default world map.
const res = await fetch('https://tiles.openfreemap.org/styles/liberty', { headers: { 'User-Agent': 'TrailExplorer/0.1' } });
const lib = await res.json();
for (const l of lib.layers) if (l.layout?.['text-font']) l.layout['text-font'] = rename(l.layout['text-font']);
await writeFile(new URL('liberty.json', out), JSON.stringify({
  sources: lib.sources,
  layers: lib.layers.filter((l) => l.type !== 'fill-extrusion'),
}));
