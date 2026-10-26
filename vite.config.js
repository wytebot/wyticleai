import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base keeps asset URLs working inside the Capacitor WebView (https://localhost/) and on any static host.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { host: '0.0.0.0', port: 5173 }
});
