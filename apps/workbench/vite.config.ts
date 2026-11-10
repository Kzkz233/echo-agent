import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
const metadata = new URL('../../dist/build-info.json', import.meta.url);
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  define: { __ECHO_BUILD__: existsSync(metadata) ? readFileSync(metadata, 'utf8') : 'undefined' },
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
