// The website build: a folder of static files to put on any web server, under
// any path. Pages load trail-explorer.js and use the <trail-explorer> element;
// index.html is a ready page that fills the window with it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  root: 'src/web',
  // Relative, so the folder works wherever it is put.
  base: './',
  plugins: [react()],
  define: { __TRAIL_VERSION__: JSON.stringify(version) },
  // The map styles, sprites and fonts, served from beside the script.
  publicDir: resolve('resources'),
  server: { host: '127.0.0.1', port: 5179, strictPort: true },
  preview: { host: '127.0.0.1', port: 5179, strictPort: true },
  worker: { format: 'es' },
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve('src/web/index.html'), 'trail-explorer': resolve('src/web/element.ts') },
      // A name that stays the same, for pages to load; everything else is hashed.
      output: { entryFileNames: (c) => (c.name === 'trail-explorer' ? 'trail-explorer.js' : 'assets/[name]-[hash].js') },
    },
  },
});
