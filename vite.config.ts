import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('src'),
  envDir: resolve('.'),
  publicDir: resolve('public'),
  build: {
    outDir: resolve('dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve('src/index.html'),
        assessment: resolve('src/assessment/index.html'),
      },
    },
  },
});
