// <trail-explorer>: the whole app as one element, for putting in a page on your
// own site. It runs in a shadow root, so the page's styles and the app's never
// mix. Everything is kept in the visitor's browser; there is no server.
//
//   <script type="module" src="/trail/trail-explorer.js"></script>
//   <trail-explorer style="height: 80vh"></trail-explorer>
//
// The element fills the size the page gives it. Map styles, sprites and fonts
// are loaded from beside the script, or from the `assets` attribute if set.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css?inline';
import appCss from '../ui/style.css?inline';
import { App } from '../ui/App.tsx';
import { useAssets, useHeatmapSource, useTrail } from '../ui/api.ts';
import { webTrail, type WebOptions } from './backend.ts';

/** What the page around the app may change. */
export interface MountOptions extends WebOptions {
  /** Where the styles, sprites and fonts folders are. Beside this script unless given. */
  assets?: string;
}

/** The page's own body rules don't reach into the shadow root, so the app's are set on its root here. */
const HOST_CSS = `
:host { display: block; position: relative; height: 100%; min-height: 400px; contain: content; }
#root { height: 100%; font: 13px/1.45 system-ui, sans-serif; color: #111; background: #fff; text-align: left; }
`;

let started: Promise<void> | null = null;

/**
 * Starts the app in `el`, inside a shadow root. One app per page: the backend and
 * the visitor's stored config are shared, so a second mount would fight the first.
 */
export async function mount(el: HTMLElement, opts: MountOptions = {}): Promise<() => void> {
  if (started) throw new Error('Trail Explorer is already on this page.');
  let root: Root | null = null;
  started = (async () => {
    useAssets(opts.assets ?? new URL('.', import.meta.url).href);
    const web = await webTrail(opts);
    useTrail(web.trail);
    useHeatmapSource(web.heatmapUrl);
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${maplibreCss}\n${appCss}\n${HOST_CSS}`;
    const div = document.createElement('div');
    div.id = 'root';
    shadow.replaceChildren(style, div);
    root = createRoot(div);
    root.render(createElement(App));
  })();
  try {
    await started;
  } catch (e) {
    started = null;
    el.textContent = `Trail Explorer could not start: ${e instanceof Error ? e.message : e}`;
    throw e;
  }
  return () => {
    root?.unmount();
    started = null;
  };
}

class TrailExplorerElement extends HTMLElement {
  private stop: (() => void) | null = null;
  connectedCallback() {
    if (this.stop) return;
    const opts: MountOptions = {};
    const assets = this.getAttribute('assets');
    if (assets) opts.assets = assets;
    // Test servers, given by the automated checks only.
    const test = (window as { __trailTest?: WebOptions }).__trailTest;
    if (test) Object.assign(opts, test);
    mount(this, opts).then((stop) => (this.stop = stop), (e) => console.error('Trail Explorer could not start:', e));
  }
  disconnectedCallback() {
    this.stop?.();
    this.stop = null;
  }
}

if (!customElements.get('trail-explorer')) customElements.define('trail-explorer', TrailExplorerElement);
