import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the site from /<repository name>/: the Pages workflow
// passes it as VITE_BASE. Other builds use relative paths; local dev uses /.
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
