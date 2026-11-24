# Trail Explorer config

This folder decides how the map looks. It is plain JSON, so you can edit it by
hand, keep it in a private git repository, or copy it to another computer or to
a website build. Trail Explorer's Customize screen edits the same files, and the
app picks up changes as soon as you save.

Every file and every setting is optional: anything missing uses the default.
If something is wrong, the app says which file and setting, uses the default
for that one setting, and keeps the rest.

Keys that start with `//` are comments, for example `"//": "my note"`.

Keep this folder private if it has zones in it: they show where you live.

## Files

| File | What it sets |
|---|---|
| `map.json` | Where the map opens, how far it zooms, background colour, road data server |
| `heatmap.json` | Colours for each number of passes, and how rides are matched |
| `layers.json` | Every layer, top first: your rides, web maps and map files |
| `maps/` | Offline map files (.pmtiles or .mbtiles) named in layers.json |
| `zones/` | Excluded zones, as GeoJSON files |
| `areas.json` | Circles to find roads and trails in |
| `routes.json`, `routes/` | Routes saved from the route planner, with a GPX file each |

## map.json

```json
{
  "view": { "center": [-0.47, 39.7], "zoom": 11 },
  "minZoom": 0,
  "maxZoom": 19,
  "background": "#eeeeee",
  "overpass": ["https://overpass-api.de/api/interpreter"],
  "circles": { "color": "#000000", "width": 2, "style": "solid" }
}
```

- `view`: where the map opens, as [longitude, latitude] and a zoom from 0
  (whole world) to 22. `null` fits the map to your rides. After the first
  start the desktop app remembers where you left it.
- `minZoom`, `maxZoom`: how far out and in the map can go.
- `background`: shown where no layer has anything.
- `overpass`: the Overpass API servers that road and trail searches ask for
  OpenStreetMap data, tried in order when one is busy. The circle's position
  is sent to them. Other public servers are listed at
  https://wiki.openstreetmap.org/wiki/Overpass_API, or run your own.
- `circles`: how the edge of the circles drawn under Roads and trails looks,
  on the map and in the route planner. `color`, `width` in pixels (0.5 to 8),
  and `style`: `"solid"`, `"dashed"` or `"dotted"`.

## heatmap.json

```json
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
```

- `bands`: a colour for each range of passes, lowest first. The first must
  start `from` 1. `label` is optional; without it the legend says "2 to 3",
  "40 or more" and so on.
- `outline`: the colour drawn around every line.
- `hide`: kinds of activity to leave off the heatmap, from `"cycling"`,
  `"running"`, `"walking"` (and hiking), `"snow"`, `"water"` and `"other"`.
  The sidebar's checkboxes under Rides change it.
- `radius` (metres), `angle` (degrees), `step` (metres): how close and how
  parallel a ride must be to count as riding an existing section, and how
  finely new sections are made. Change these only to tune the drawing.

## layers.json

```json
{
  "layers": [
    { "id": "heatmap", "type": "heatmap", "name": "My rides", "on": true, "opacity": 1 },
    { "id": "roads", "type": "roads", "name": "Roads and trails", "on": true, "opacity": 1 },
    { "id": "home", "type": "file", "name": "Home trails", "file": "maps/home.pmtiles", "on": true, "opacity": 1 },
    { "id": "topo", "type": "raster", "name": "Topo", "note": "OpenTopoMap",
      "tiles": ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png"],
      "attribution": "© OpenTopoMap", "maxzoom": 17, "on": false, "opacity": 1 },
    { "id": "openfreemap", "type": "openfreemap", "name": "World map", "on": true, "opacity": 1 }
  ]
}
```

The first layer is drawn on top. Every layer has an `id` (lower-case letters,
digits, - and _), a `name`, and optionally a `note`, `on` and `opacity`
(0.05 to 1). The types are:

- `heatmap`: your rides. There is always exactly one. Optional `width` (0.25 to
  3, normally 1) makes the ride lines thinner or thicker.
- `roads`: the roads and trails found in the circles you draw (see areas.json),
  dashed. There is always exactly one, normally just under your rides so
  ridden trails show in ride colours. It takes the same optional `width`.
- `openfreemap`: the OpenFreeMap world map, with the bundled style.
- `raster`: picture tiles from the web. `tiles` lists one or more https
  addresses with {z}, {x} and {y} in them; list each server separately rather
  than using {s}. Optional: `attribution`, `minzoom`, `maxzoom`,
  `tileSize` (256 or 512) and `bounds` ([west, south, east, north]).
- `file`: an offline map in the `maps` folder, such as one from
  extract.bbbike.org. Adding a map in the app puts it there for you.

## zones/

Any `.geojson` file here lists places to leave out of the heatmap, such as
around home. A ride passing through a zone is cut where it enters and leaves.
The app keeps the zones you draw in `zones/zones.geojson`. You can add more
files, made with any map tool such as geojson.io or QGIS.

- A circle is a Point with a `radius` in metres:
  `{ "type": "Feature", "properties": { "name": "Home", "radius": 300 }, "geometry": { "type": "Point", "coordinates": [-0.47, 39.7] } }`
- Any Polygon or MultiPolygon works too, holes included.

## areas.json

The circles drawn under Roads and trails, one per line, and the groups they
are in. Draw them in the app, or add them by hand. The app downloads what each
one needs.

```json
{
  "groups": [
    { "id": "g-4kd02x", "name": "Sierra Calderona", "joined": true }
  ],
  "areas": [
    { "id": "k3x9qa", "name": "Calderona", "center": [-0.47, 39.7], "radius": 1500, "on": true, "hide": ["road"], "group": "g-4kd02x" },
    { "id": "p0z7mm", "center": [-0.45, 39.71], "radius": 1200, "on": true, "hide": ["road"], "group": "g-4kd02x" },
    { "center": [-0.52, 39.65], "radius": 800 }
  ]
}
```

- `center`: [longitude, latitude]. `radius`: metres, from 50 to 10000.
- `name`: optional.
- `on`: whether it shows on the map. `hide`: kinds of road left off the map
  for this area: `"trail"`, `"track"`, `"cycleway"`, `"road"`.
- `id`: lets the app change one area. It is made for you when left out.
- `group`: the id of the group it is in. Optional.

`groups` is optional. A group puts several circles under one name, since one
place often takes more than one circle to cover. Each has an `id` (up to 40
lowercase letters, digits and dashes, not used by any area), a `name`, and
`joined`: `true` shows its circles as one area, with one outline around them
all and one list of roads and trails, counting overlaps once; `false` (the
default) keeps each circle its own area, listed under the group. A group with
no circles is dropped the next time the app saves the file.

The road data is not in this folder. The app keeps one shared copy of it
(`osm.db` in its data folder), so overlapping areas never download or store
anything twice. Moved to another computer, the areas download again there.

## routes.json and routes/

Routes saved from the route planner. `routes.json` lists them, one per line,
with their stats as planned; `routes/<id>.gpx` holds each route's track, with
elevations. Rename and delete them in the app's Routes screen. A name changed
here by hand shows in the app too; the GPX file keeps the name it was saved
with until the route is renamed in the app.
