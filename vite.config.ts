import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  // Absolute asset paths keep nested routes such as /documents/:id loadable on reload.
  base: '/',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // The API accepts only its own address in Host, so the proxy sends the target's address.
      '^/api/': { target: 'http://127.0.0.1:7175', changeOrigin: true },
    },
  },
});
