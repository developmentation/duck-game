import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    // SINGLE=1 builds one chunk with every asset inlined, which
    // tools/bundle-single.mjs folds into a single playable .html file.
    assetsInlineLimit: process.env.SINGLE ? 100_000_000 : 0,
    chunkSizeWarningLimit: 4000,
    rollupOptions: process.env.SINGLE
      ? { output: { inlineDynamicImports: true, manualChunks: undefined } }
      : { output: { manualChunks: { three: ['three'] } } },
  },
});
