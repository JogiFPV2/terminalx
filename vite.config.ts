import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Tauri ładuje frontend z dev servera na stałym porcie albo z dist/ w buildzie.
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { target: 'es2022', minify: 'esbuild', sourcemap: false, chunkSizeWarningLimit: 1500 },
  envPrefix: ['VITE_', 'TAURI_'],
});
