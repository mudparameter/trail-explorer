import { AttributionControl, Map as GLMap, NavigationControl, ScaleControl, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef } from 'react';
import type { Bounds, View } from '../core/api.ts';

setWorkerUrl(new URL(workerUrl, location.href).href);

interface Props {
  style: StyleSpecification;
  view: View | null;
  focus: Bounds | null;
  goTo: { bounds: Bounds; n: number } | null;
  /** Called once the jump is made, so it is not repeated. */
  onWent(): void;
  onView(v: View): void;
  onTileError(message: string | null): void;
}

export function MapView({ style, view, focus, goTo, onWent, onView, onTileError }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<GLMap | null>(null);
  const cb = useRef({ onWent, onView, onTileError });
  cb.current = { onWent, onView, onTileError };

  useEffect(() => {
    const m = new GLMap({
      container: el.current!, style, attributionControl: false, dragRotate: false, pitchWithRotate: false, maxZoom: 19,
      ...(view ? { center: view.center, zoom: view.zoom } : focus ? { bounds: focus, fitBoundsOptions: { padding: 40 } } : { center: [0, 25] as [number, number], zoom: 1.4 }),
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
    if (!goTo || !map.current) return;
    map.current.fitBounds(goTo.bounds, { padding: 40, duration: 0, maxZoom: 16 });
    cb.current.onWent();
  }, [goTo]);

  return <div className="map" ref={el} />;
}
