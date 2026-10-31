import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // changeOrigin sends the API's own Host (127.0.0.1:8787), which the server's Host check accepts.
    // 127.0.0.1, not localhost: the server listens on IPv4 loopback only.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
});
