import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The client's build.
 *
 * `@server` mirrors the tsconfig path so the two never disagree, and in practice it is never
 * exercised at bundle time: every engine and server import is type-only and esbuild erases it.
 * The proxy exists so the API keeps no CORS headers and stays bound to loopback.
 */
export default defineConfig({
    plugins: [react()],
    resolve: {alias: {'@server': fileURLToPath(new URL('../server/src', import.meta.url))}},
    server: {port: 5173, proxy: {'/api': {target: process.env.FLORY_CONSOLE_API ?? 'http://127.0.0.1:8094', changeOrigin: false}}},
    build: {outDir: 'dist', sourcemap: true, target: 'es2022'},
});
