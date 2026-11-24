// Written into every new config folder, and kept as config.example/README.md.
export const CONFIG_README = `# Trail Explorer config

This folder decides how the map looks. It is plain JSON, so you can edit it by
hand, keep it in a private git repository, or copy it to another computer or to
a website build. Trail Explorer's Customize screen edits the same files, and the
app picks up changes as soon as you save.

Every file and every setting is optional: anything missing uses the default.
If something is wrong, the app says which file and setting, uses the default
for that one setting, and keeps the rest.

Keys that start with \`//\` are comments, for example \`"//": "my note"\`.

Keep this folder private if it has zones in it: they show where you live.

## Files

| File | What it sets |
|---|---|
| \`map.json\` | Where the map opens, how far it zooms, background colour |
| \`heatmap.json\` | Colours for each number of passes, and how rides are matched |
| \`layers.json\` | Every layer, top first: your rides, web maps and map files |
| \`maps/\` | Offline map files (.pmtiles or .mbtiles) named in layers.json |
| \`zones/\` | Excluded zones, as GeoJSON files |

## map.json

\`\`\`json
{
  "view": { "center": [-0.47, 39.7], "zoom": 11 },
  "minZoom": 0,
  "maxZoom": 19,
  "background": "#eeeeee"
}
\`\`\`

- \`view\`: where the map opens, as [longitude, latitude] and a zoom from 0
  (whole world) to 22. \`null\` fits the map to your rides. After the first
  start the desktop app remembers where you left it.
- \`minZoom\`, \`maxZoom\`: how far out and in the map can go.
- \`background\`: shown where no layer has anything.

## heatmap.json

\`\`\`json
{
  "bands": [
    { "from": 1, "color": "#2f6bff" },
    { "from": 2, "color": "#8a3ffc" },
    { "from": 40, "color": "#ffffff", "label": "Lots" }
  ],
  "outline": "#14141e",
  "radius": 15,
  "angle": 35,
  "step": 10
}
\`\`\`

- \`bands\`: a colour for each range of passes, lowest first. The first must
  start \`from\` 1. \`label\` is optional; without it the legend says "2 to 3",
  "40 or more" and so on.
- \`outline\`: the colour drawn around every line.
- \`radius\` (metres), \`angle\` (degrees), \`step\` (metres): how close and how
  parallel a ride must be to count as riding an existing section, and how
  finely new sections are made. Change these only to tune the drawing.

## layers.json

\`\`\`json
{
  "layers": [
    { "id": "heatmap", "type": "heatmap", "name": "My rides", "on": true, "opacity": 1 },
    { "id": "home", "type": "file", "name": "Home trails", "file": "maps/home.pmtiles", "on": true, "opacity": 1 },
    { "id": "topo", "type": "raster", "name": "Topo", "note": "OpenTopoMap",
      "tiles": ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png"],
      "attribution": "© OpenTopoMap", "maxzoom": 17, "on": false, "opacity": 1 },
    { "id": "openfreemap", "type": "openfreemap", "name": "World map", "on": true, "opacity": 1 }
  ]
}
\`\`\`

The first layer is drawn on top. Every layer has an \`id\` (lower-case letters,
digits, - and _), a \`name\`, and optionally a \`note\`, \`on\` and \`opacity\`
(0.05 to 1). The types are:

- \`heatmap\`: your rides. There is always exactly one.
- \`openfreemap\`: the OpenFreeMap world map, with the bundled style.
- \`raster\`: picture tiles from the web. \`tiles\` lists one or more https
  addresses with {z}, {x} and {y} in them; list each server separately rather
  than using {s}. Optional: \`attribution\`, \`minzoom\`, \`maxzoom\`,
  \`tileSize\` (256 or 512) and \`bounds\` ([west, south, east, north]).
- \`file\`: an offline map in the \`maps\` folder, such as one from
  extract.bbbike.org. Adding a map in the app puts it there for you.

## zones/

Any \`.geojson\` file here lists places to leave out of the heatmap, such as
around home. A ride passing through a zone is cut where it enters and leaves.
The app keeps the zones you draw in \`zones/zones.geojson\`. You can add more
files, made with any map tool such as geojson.io or QGIS.

- A circle is a Point with a \`radius\` in metres:
  \`{ "type": "Feature", "properties": { "name": "Home", "radius": 300 }, "geometry": { "type": "Point", "coordinates": [-0.47, 39.7] } }\`
- Any Polygon or MultiPolygon works too, holes included.
`;
