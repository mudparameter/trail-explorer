import { AttributionControl, Map as GLMap, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef } from 'react';
import type { Bounds, View } from '../core/api.ts';
import { drawnShape, shapeRing, type Shape } from '../core/shapes.ts';
import { DRAW, ROAD_LINES } from './mapstyle.ts';

setWorkerUrl(new URL(workerUrl, location.href).href);

interface Props {
  style: StyleSpecification;
  /** Where to open: the saved view, else the config's start view, else the rides, else the world. */
  view: View | null;
  startView: View | null;
  focus: Bounds | null;
  minZoom: number;
  maxZoom: number;
  /** Clicks place something, such as a zone, instead of moving the map. */
  placing: boolean;
  onPlace(at: [number, number]): void;
  /** Clicks draw a shape: a circle's centre then its edge, or a rectangle's two opposite corners. */
  drawing: boolean;
  drawShape: Shape['kind'];
  onDrawn(shape: Shape): void;
  /** The shape so far while drawing, or null before the first click. */
  onDrawShape(s: Shape | null): void;
  /** A found road was clicked, or the map away from them. */
  onPickRoad(key: string | null): void;
  goTo: { bounds: Bounds | View; n: number } | null;
  /** Called once the jump is made, so it is not repeated. */
  onWent(): void;
  onView(v: View): void;
  onTileError(message: string | null): void;
}

export function MapView(props: Props) {
  const { style, view, startView, focus, minZoom, maxZoom, placing, drawing, goTo } = props;
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<GLMap | null>(null);
  const cb = useRef(props);
  cb.current = props;
  /** The first click of the shape being drawn. */
  const start = useRef<[number, number] | null>(null);

  useEffect(() => {
    const m = new GLMap({
      container: el.current!, style, attributionControl: false, dragRotate: false, pitchWithRotate: false, minZoom, maxZoom,
      ...(view ?? startView ? { center: (view ?? startView)!.center, zoom: (view ?? startView)!.zoom }
        : focus ? { bounds: focus, fitBoundsOptions: { padding: 40 } } : { center: [0, 25] as [number, number], zoom: 1.4 }),
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new ScaleControl(), 'bottom-left');
    m.addControl(new AttributionControl({ compact: false }), 'bottom-right');
    let t = 0;
    m.on('moveend', () => {
      clearTimeout(t);
      t = window.setTimeout(() => cb.current.onView({ center: m.getCenter().toArray() as [number, number], zoom: m.getZoom() }), 300);
    });
    m.on('error', (e) => {
      console.error('Map error:', e.error?.message);
      if (!navigator.onLine) cb.current.onTileError('No internet. Default maps need it. Your rides and custom maps still work.');
    });
    const shapeTo = (at: [number, number]) => drawnShape(cb.current.drawShape, start.current!, at);
    m.on('click', (e) => {
      const at = e.lngLat.toArray() as [number, number];
      if (cb.current.placing) cb.current.onPlace(at);
      else if (cb.current.drawing) {
        if (!start.current) {
          start.current = at;
          cb.current.onDrawShape(shapeTo(at));
        } else {
          const s = shapeTo(at);
          start.current = null;
          cb.current.onDrawn(s);
        }
      } else if (m.getLayer(ROAD_LINES)) {
        const p = e.point;
        const hit = m.queryRenderedFeatures([[p.x - 4, p.y - 4], [p.x + 4, p.y + 4]], { layers: [ROAD_LINES] })[0];
        cb.current.onPickRoad(hit ? String(hit.properties.key) : null);
      }
    });
    m.on('mousemove', (e) => {
      if (!cb.current.drawing || !start.current) return;
      const s = shapeTo(e.lngLat.toArray() as [number, number]);
      const src = m.getSource(DRAW) as GeoJSONSource | undefined;
      src?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [shapeRing(s.kind === 'circle' ? { ...s, radius: Math.max(s.radius, 1) } : s)] } });
      cb.current.onDrawShape(s);
    });
    m.on('mouseenter', ROAD_LINES, () => {
      if (!cb.current.placing && !cb.current.drawing) m.getCanvas().style.cursor = 'pointer';
    });
    m.on('mouseleave', ROAD_LINES, () => {
      if (!cb.current.placing && !cb.current.drawing) m.getCanvas().style.cursor = '';
    });
    const online = () => cb.current.onTileError(null);
    window.addEventListener('online', online);
    map.current = m;
    (window as any).__map = m; // used by the automated checks
    return () => {
      window.removeEventListener('online', online);
      m.remove();
    };
  }, []);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else map.current?.setStyle(style, { diff: true });
  }, [style]);
  useEffect(() => {
    map.current?.setMinZoom(minZoom);
    map.current?.setMaxZoom(maxZoom);
  }, [minZoom, maxZoom]);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.getCanvas().style.cursor = placing || drawing ? 'crosshair' : '';
    // Two clicks to draw would otherwise zoom in.
    if (drawing) m.doubleClickZoom.disable();
    else m.doubleClickZoom.enable();
    if (!drawing) start.current = null;
  }, [placing, drawing]);
  useEffect(() => {
    if (!goTo || !map.current) return;
    const b = goTo.bounds;
    if (Array.isArray(b)) map.current.fitBounds(b, { padding: 40, duration: 0, maxZoom: 16 });
    else map.current.jumpTo({ center: b.center, zoom: b.zoom });
    cb.current.onWent();
  }, [goTo]);

  return <div className="map" ref={el} />;
}
