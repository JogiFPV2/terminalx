import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import pkg from '../package.json' with { type: 'json' };

// Aplikacja Hermitty na Androida (Tauri 2, mobile/src-tauri). Korzysta z motywów i ikon aplikacji na komputer (../src/lib).
export default defineConfig({
  root: __dirname,
  plugins: [svelte()],
  clearScreen: false,
  // Na telefonie dev server musi być osiągalny w sieci (tauri android dev ustawia TAURI_DEV_HOST).
  server: { port: 1421, strictPort: true, host: process.env.TAURI_DEV_HOST || false, watch: { ignored: ['**/src-tauri/**'] } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', minify: 'esbuild', sourcemap: false },
  envPrefix: ['VITE_', 'TAURI_'],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});
