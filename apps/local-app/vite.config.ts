import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => ({
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5175,
    strictPort: false,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.VITE_API_PORT || '3000'}`,
        changeOrigin: true,
      },
      '/health': {
        target: `http://127.0.0.1:${process.env.VITE_API_PORT || '3000'}`,
        changeOrigin: true,
      },
      '/socket.io': {
        target: `http://127.0.0.1:${process.env.VITE_API_PORT || '3000'}`,
        ws: true,
      },
      '/wt': {
        target: `http://127.0.0.1:${process.env.VITE_API_PORT || '3000'}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
  },
}));
