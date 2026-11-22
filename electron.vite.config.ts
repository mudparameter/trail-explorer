import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

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
  renderer: { root: 'src/ui', plugins: [react()], build: { outDir: 'out/ui', rollupOptions: { input: 'src/ui/index.html' } } },
});
