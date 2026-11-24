import { AttributionControl, Map as GLMap, NavigationControl, ScaleControl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import type { Bounds } from '../core/api.ts';
import { HOVER } from './planstyle.ts';

interface Props {
  style: StyleSpecification;
  /** Fitted to when it changes. */
  bounds: Bounds | null;
  /** What a click on the map does, if anything. */
  clicking: 'start' | 'finish' | null;
  onClick(at: [number, number]): void;
  /** A route line was clicked. */
  onPickRoute?(id: string): void;
  /** A point to mark, such as where the mouse is on the elevation profile. */
  hover: [number, number] | null;
}

/** The map of the route planner and of a saved route. */
export function PlanMap({ style, bounds, clicking, onClick, onPickRoute, hover }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<GLMap | null>(null);
  const cb = useRef({ clicking, onClick, onPickRoute });
  cb.current = { clicking, onClick, onPickRoute };

  useEffect(() => {
    const m = new GLMap({ container: el.current!, style, attributionControl: false, dragRotate: false, pitchWithRotate: false, center: [0, 25], zoom: 1.4 });
    m.touchZoomRotate.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.addControl(new ScaleControl({ unit: 'imperial' }), 'bottom-left');
    m.addControl(new AttributionControl({ compact: false, customAttribution: 'Elevation: Mapzen Terrain Tiles' }), 'bottom-right');
    m.on('click', (e) => {
      if (cb.current.clicking) {
        cb.current.onClick(e.lngLat.toArray() as [number, number]);
        return;
      }
      if (!cb.current.onPickRoute || !m.getLayer('route-line')) return;
      const p = e.point;
      const hit = m.queryRenderedFeatures([[p.x - 5, p.y - 5], [p.x + 5, p.y + 5]], { layers: ['route-line'] })[0];
      if (hit) cb.current.onPickRoute(String(hit.properties.id));
    });
    m.on('mouseenter', 'route-line', () => {
      if (!cb.current.clicking && cb.current.onPickRoute) m.getCanvas().style.cursor = 'pointer';
    });
    m.on('mouseleave', 'route-line', () => {
      if (!cb.current.clicking) m.getCanvas().style.cursor = '';
    });
    m.on('error', (e) => console.error('Map error:', e.error?.message));
    map.current = m;
    (window as any).__planMap = m; // used by the automated checks
    return () => m.remove();
  }, []);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else map.current?.setStyle(style, { diff: true });
  }, [style]);
  useEffect(() => {
    if (bounds) map.current?.fitBounds(bounds, { padding: 40, duration: 0, maxZoom: 16 });
  }, [bounds]);
  useEffect(() => {
    const m = map.current;
    if (m) m.getCanvas().style.cursor = clicking ? 'crosshair' : '';
  }, [clicking]);
  useEffect(() => {
    const m = map.current;
    const set = () => (m?.getSource(HOVER) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection', features: hover ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: hover } }] : [],
    });
    if (m?.isStyleLoaded()) set();
    else m?.once('idle', set);
  }, [hover, style]);

  return <div className="map" ref={el} />;
}
