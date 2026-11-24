import { useEffect, useMemo, useRef, useState } from 'react';
import { STEEP, type RouteStats } from '../core/route.ts';
import { metres } from '../core/track.ts';

/** Height, and the margins for the axis labels, in pixels. The width is the panel's. */
const H = 170, L = 46, R = 50, T = 10, B = 26;
const fmt = (x: number, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Round steps for an axis: 1, 2 or 5 × a power of ten, about `n` of them. */
function ticks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo || 1;
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

/**
 * The elevation profile: metres on the left, feet on the right, km below and
 * miles above. Steep climbs and descents are shaded. Hovering reports where.
 */
export function Profile({ stats, onHover }: { stats: RouteStats; onHover?(d: number | null): void }) {
  const [at, setAt] = useState<number | null>(null);
  // Drawn at the panel's own width, one unit per pixel, so it fills the panel and
  // the line under the mouse is the place it reports. Scaling a fixed drawing to
  // fit left it narrower than the panel, and off from the mouse.
  const box = useRef<HTMLElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const p = stats.profile;
  const view = useMemo(() => {
    if (p.length < 2 || stats.minEle === null) return null;
    const dist = p[p.length - 1]![0] || 1;
    const lo = Math.floor(Math.min(...p.map((x) => x[1])) / 10) * 10 - 10;
    const hi = Math.ceil(Math.max(...p.map((x) => x[1])) / 10) * 10 + 10;
    const x = (d: number) => L + (d / dist) * (W - L - R);
    const y = (e: number) => T + (1 - (e - lo) / (hi - lo)) * (H - T - B);
    const line = p.map(([d, e], i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)},${y(e).toFixed(1)}`).join('');
    return { dist, lo, hi, x, y, line, area: `${line}L${x(dist)},${H - B}L${x(0)},${H - B}Z` };
  }, [p, stats.minEle, W]);
  if (!view) return <figure className="profile" ref={box}><p className="small">No elevation data for this route.</p></figure>;
  const { dist, lo, hi, x, y } = view;
  const eleAt = (d: number) => {
    const i = Math.max(1, p.findIndex((q) => q[0] >= d));
    const [d0, e0] = p[i - 1]!, [d1, e1] = p[i] ?? p[i - 1]!;
    return d1 === d0 ? e0 : e0 + ((e1 - e0) * (d - d0)) / (d1 - d0);
  };
  const gradeAt = (d: number) => {
    const a = Math.max(0, d - 25), b = Math.min(dist, d + 25);
    return b > a ? ((eleAt(b) - eleAt(a)) / (b - a)) * 100 : 0;
  };
  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / (r.width || 1)) * W;
    const d = Math.max(0, Math.min(dist, ((px - L) / (W - L - R)) * dist));
    setAt(d);
    onHover?.(d);
  };
  const leave = () => {
    setAt(null);
    onHover?.(null);
  };
  // About one label per 100 pixels, so a wide panel gets more of them.
  const n = Math.max(3, Math.round((W - L - R) / 100));
  const kmTicks = ticks(0, dist / 1000, n);
  const miTicks = ticks(0, dist / 1609.344, n);
  const mTicks = ticks(lo, hi, 4);
  const ftTicks = ticks(lo * 3.28084, hi * 3.28084, 4);
  return (
    <figure className="profile" ref={box}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Elevation profile" onMouseMove={move} onMouseLeave={leave}>
        {stats.steepUp.map((s, i) => <rect key={`u${i}`} x={x(s.from)} width={Math.max(1, x(s.to) - x(s.from))} y={T} height={H - T - B} className="steep-up" />)}
        {stats.steepDown.map((s, i) => <rect key={`d${i}`} x={x(s.from)} width={Math.max(1, x(s.to) - x(s.from))} y={T} height={H - T - B} className="steep-down" />)}
        <path d={view.area} className="ground" />
        <path d={view.line} className="outline" />
        {mTicks.map((m) => (
          <g key={`m${m}`}>
            <line x1={L} x2={W - R} y1={y(m)} y2={y(m)} className="grid" />
            <text x={L - 4} y={y(m) + 4} textAnchor="end">{fmt(m)} m</text>
          </g>
        ))}
        {ftTicks.map((f) => (y(f / 3.28084) >= T && y(f / 3.28084) <= H - B ? <text key={`f${f}`} x={W - R + 4} y={y(f / 3.28084) + 4}>{fmt(f)} ft</text> : null))}
        {kmTicks.map((k) => <text key={`k${k}`} x={x(k * 1000)} y={H - 8} textAnchor="middle">{fmt(k, k % 1 ? 1 : 0)} km</text>)}
        {miTicks.map((mi) => (x(mi * 1609.344) <= W - R ? <text key={`i${mi}`} x={x(mi * 1609.344)} y={T + 10} textAnchor="middle" className="top">{fmt(mi, mi % 1 ? 1 : 0)} mi</text> : null))}
        {at !== null && (
          <g>
            <line x1={x(at)} x2={x(at)} y1={T} y2={H - B} className="cursor" />
            <circle cx={x(at)} cy={y(eleAt(at))} r={3.5} className="dot" />
          </g>
        )}
      </svg>
      <figcaption className="small">
        {at === null ? (
          <>Hover for details. Shaded: climbs <span className="key steep-up" /> and descents <span className="key steep-down" /> of {STEEP}% or more over 50 m.</>
        ) : (
          <>
            {fmt(at / 1000, 2)} km ({fmt(at / 1609.344, 2)} mi) · {fmt(eleAt(at))} m ({fmt(eleAt(at) * 3.28084)} ft) · {gradeAt(at) >= 0 ? '+' : ''}{fmt(gradeAt(at), 1)}%
          </>
        )}
      </figcaption>
    </figure>
  );
}

/** The point `d` metres along a line. */
export function pointAt(line: [number, number, number][], d: number): [number, number] | null {
  if (!line.length) return null;
  let done = 0;
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1]!, [x1, y1] = line[i]!;
    const seg = metres(x0, y0, x1, y1);
    if (done + seg >= d) {
      const t = seg ? (d - done) / seg : 0;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }
    done += seg;
  }
  const last = line[line.length - 1]!;
  return [last[0], last[1]];
}
