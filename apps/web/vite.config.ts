import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@mindchestra/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts')
    }
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:4311',
        changeOrigin: true
      }
    }
  }
});
