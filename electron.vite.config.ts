import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const DEV_PORT = 5178;

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      externalizeDeps: false,
      rollupOptions: {
        input: { main: 'src/desktop/main.ts', worker: 'src/desktop/worker.ts' },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { preload: 'src/desktop/preload.ts' }, output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: 'src/ui',
    plugins: [react()],
    // Dev only. The window still loads trail://app, which passes requests on to
    // this server, so the app behaves the same as when packaged.
    server: { host: '127.0.0.1', port: DEV_PORT, strictPort: true, hmr: { protocol: 'ws', host: '127.0.0.1', clientPort: DEV_PORT } },
    build: { outDir: 'out/ui', rollupOptions: { input: resolve('src/ui/index.html') } },
  },
});
