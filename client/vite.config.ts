import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds use relative paths, so the site works wherever it's served
// (GitHub Pages puts it under /<repository name>/, which changes if the repo
// is renamed or moved). Local dev uses /. VITE_BASE overrides both.
export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE ?? (command === 'build' ? './' : '/'),
  plugins: [react()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
  server: { port: 5173, host: true },
}));
