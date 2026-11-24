import { AttributionControl, Map as GLMap, NavigationControl, ScaleControl, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef } from 'react';
import type { Bounds, View } from '../core/api.ts';

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
  goTo: { bounds: Bounds | View; n: number } | null;
  /** Called once the jump is made, so it is not repeated. */
  onWent(): void;
  onView(v: View): void;
  onTileError(message: string | null): void;
}

export function MapView({ style, view, startView, focus, minZoom, maxZoom, placing, onPlace, goTo, onWent, onView, onTileError }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<GLMap | null>(null);
  const cb = useRef({ onWent, onView, onTileError, onPlace, placing });
  cb.current = { onWent, onView, onTileError, onPlace, placing };

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
    m.on('click', (e) => {
      if (cb.current.placing) cb.current.onPlace(e.lngLat.toArray() as [number, number]);
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
    if (map.current) map.current.getCanvas().style.cursor = placing ? 'crosshair' : '';
  }, [placing]);
  useEffect(() => {
    if (!goTo || !map.current) return;
    const b = goTo.bounds;
    if (Array.isArray(b)) map.current.fitBounds(b, { padding: 40, duration: 0, maxZoom: 16 });
    else map.current.jumpTo({ center: b.center, zoom: b.zoom });
    cb.current.onWent();
  }, [goTo]);

  return <div className="map" ref={el} />;
}
