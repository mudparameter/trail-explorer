// Phone-sized layouts. The app is narrow when the space it has is narrow, not the
// window: on a website it may be one part of a wider page.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/** Below this width, in CSS pixels, the app uses its phone layout. */
export const NARROW = 760;

export const NarrowContext = createContext(false);
/** The app is using its phone layout. */
export const useNarrow = () => useContext(NarrowContext);

/** A ref for the app's outer element, and whether that element is narrow. */
export function useMeasureNarrow(): [(el: HTMLElement | null) => void, boolean] {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < NARROW);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    ro.current = new ResizeObserver(([e]) => setNarrow(e!.contentRect.width < NARROW));
    ro.current.observe(el);
  }, []);
  useEffect(() => () => ro.current?.disconnect(), []);
  return [ref, narrow];
}

/** Touch is the main way in, so the map is tapped, not clicked. */
export function useTouch(): boolean {
  const [touch, setTouch] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const q = matchMedia('(pointer: coarse)');
    const on = () => setTouch(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return touch;
}
