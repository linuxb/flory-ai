import {fileURLToPath} from 'node:url';
import {defineConfig, type UserConfig} from 'vite';
import react from '@vitejs/plugin-react';
import type {InlineConfig} from 'vitest/node';

/**
 * The tests' settings. Coverage is off unless `--coverage` is passed. The lcov report names files
 * from the repository root rather than from this package, so an uploaded `src/graph/layout.ts`
 * cannot be mistaken for some other package's `src/`: Codecov reads
 * `console/client/src/graph/layout.ts` and nothing else.
 *
 * Typed by Vitest rather than through `vitest/config`'s `defineConfig`, because Vitest 2 carries a
 * Vite 5 of its own: its `defineConfig` would type the whole file against that Vite and reject the
 * Vite 7 plugins the build uses. Only this block is Vitest's, so only this block takes its type.
 */
const test: InlineConfig = {
    coverage: {
        provider: 'v8',
        reporter: ['text-summary', 'html', ['lcovonly', {projectRoot: fileURLToPath(new URL('../..', import.meta.url))}], 'json-summary'],
        reportsDirectory: 'coverage',
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/test/**'],
    },
};

/**
 * The client's build.
 *
 * `@server` mirrors the tsconfig path so the two never disagree, and in practice it is never
 * exercised at bundle time: every engine and server import is type-only and esbuild erases it.
 * The proxy exists so the API keeps no CORS headers and stays bound to loopback.
 */
const config: UserConfig & {test: InlineConfig} = {
    plugins: [react()],
    resolve: {alias: {'@server': fileURLToPath(new URL('../server/src', import.meta.url))}},
    server: {port: 5173, proxy: {'/api': {target: process.env.FLORY_CONSOLE_API ?? 'http://127.0.0.1:8094', changeOrigin: false}}},
    build: {outDir: 'dist', sourcemap: true, target: 'es2022'},
    test,
};

export default defineConfig(config);
