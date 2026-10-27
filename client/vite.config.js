import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The React client. In development Vite serves it on :5173 and proxies the API, auth and
// WebSocket to a running Node server (default app1 on :3001). In production `npm run build`
// writes client/dist, which Express serves.
const backend = process.env.OMC_BACKEND || 'http://localhost:3001';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': backend,
      '/auth': backend,
      '/healthz': backend,
      '/ws': {
        target: backend,
        ws: true,
        // The server checks Origin on upgrade; present the backend's own origin in dev.
        configure(proxy) {
          proxy.on('proxyReqWs', (proxyReq) => proxyReq.setHeader('origin', backend));
        },
      },
    },
  },
});
