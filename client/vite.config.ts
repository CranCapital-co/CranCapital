import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the site from /CranCapital/; local dev from /.
export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE ?? (command === 'build' ? '/CranCapital/' : '/'),
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
