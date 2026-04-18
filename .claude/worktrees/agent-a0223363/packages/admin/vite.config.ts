import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  base: '/admin/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/widget': 'http://localhost:3001',
      '/admin/widget': {
        target: 'http://localhost:3001',
        rewrite: (path: string) => path.replace('/admin/widget', '/widget'),
      },
      '/GETTING_STARTED.md': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
