import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base so the same build works on localhost:3000, any tunnel URL,
  // and GitHub Pages project sites (https://<user>.github.io/<repo>/) without
  // knowing the repo name ahead of time. Override with VITE_BASE if needed.
  base: process.env.VITE_BASE || './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    cssCodeSplit: true,
    cssMinify: true,
    minify: 'esbuild',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          md: ['marked', 'dompurify'],
        },
      },
    },
  },
  optimizeDeps: { include: ['react', 'react-dom', 'marked', 'dompurify'] },
});
