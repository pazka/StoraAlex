import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The Fastify API runs on PORT (default 8080). In dev, Vite serves the client
// on 5173 and proxies API + media calls to Fastify so cookies stay same-origin.
const API_TARGET = process.env.API_TARGET || 'http://localhost:8080';

export default defineConfig({
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
      '/media': { target: API_TARGET, changeOrigin: false },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script', // external registerSW.js, no inline script (CSP-friendly)
      includeAssets: ['icon.svg'],
      workbox: {
        // Never let the SW intercept API/media; those require live auth.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/media/],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
      manifest: {
        name: 'StorAlex',
        short_name: 'StorAlex',
        description: 'Storage-unit inventory: scan QR labels in and out.',
        theme_color: '#1f2933',
        background_color: '#1f2933',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
