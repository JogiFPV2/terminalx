import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import pkg from './package.json' with { type: 'json' };

// Tauri ładuje frontend z dev servera na stałym porcie albo z dist/ w buildzie.
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { target: 'es2022', minify: 'esbuild', sourcemap: false, chunkSizeWarningLimit: 1500 },
  envPrefix: ['VITE_', 'TAURI_'],
  // Jedna wersja dla całej aplikacji: package.json (tauri.conf.json też ją stamtąd czyta).
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});
