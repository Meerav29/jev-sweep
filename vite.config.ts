import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The web app reaches the API same-origin through the proxy. Vite's default CORS allows any localhost origin and
    // answers preflights itself, which would let a page on another local port POST JSON to the API through here.
    cors: false,
    // changeOrigin sends the API's own Host (127.0.0.1:8787), which the server's Host check accepts.
    // 127.0.0.1, not localhost: the server listens on IPv4 loopback only.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
});
