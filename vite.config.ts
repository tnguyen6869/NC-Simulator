import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: true,
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          codemirror: ['codemirror', '@codemirror/view', '@codemirror/state',
                       '@codemirror/language', '@codemirror/commands',
                       '@codemirror/search', '@codemirror/theme-one-dark'],
        },
      },
    },
  },
});
