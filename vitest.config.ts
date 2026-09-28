import {configDefaults, defineConfig} from 'vitest/config';
import {testDatabaseUrl} from './test/setup/database.js';

export default defineConfig({
    test: {
        // The suites run against their own database, provisioned by the global setup below. They
        // used to share the development one, where a Coordinator left running in another terminal
        // claims from the same global work queue and makes leasing assertions fail for reasons
        // that have nothing to do with the code under test.
        // The client is a separate package with its own install and its own CI job, and this
        // suite must not need React to run. Without the exclusion the default include sweeps up
        // `console/client/src/test`, which worked only because both installs happen to exist on a
        // developer's machine: the moment a client test imported a client-only package, the job
        // that installs the root and nothing else failed on a file it was never meant to run.
        exclude: [...configDefaults.exclude, 'console/client/**'],
        globalSetup: ['test/setup/database.ts'],
        env: {DATABASE_URL: testDatabaseUrl()},
        // Still one database for every file, and `work_queue` is global within it, so one suite's
        // queued work is claimable by another's assertions. Files run one at a time.
        fileParallelism: false,
        // Off unless `--coverage` is passed (`npm run test:coverage`), so `npm test` costs nothing
        // extra. The measured code is what runs inside this process: `db/` and `scripts/` are left
        // out because the suites reach them through a child process — `test/setup/database.ts`
        // spawns `db/bootstrap.ts` — which V8 cannot see, and counting them would report as untested
        // code the suites in fact run. The same holds for the Console's process entry. Generated
        // code is not ours to test: its shape belongs to the generator.
        coverage: {
            provider: 'v8',
            reporter: ['text-summary', 'html', 'lcovonly', 'json-summary'],
            reportsDirectory: 'coverage',
            include: ['engine/src/**/*.ts', 'sdk/typescript/**/*.ts', 'console/server/src/**/*.ts'],
            exclude: ['**/*.test.ts', 'engine/src/generated/**', 'sdk/typescript/gen/**', 'sdk/typescript/gen-health/**', 'console/server/src/main.ts'],
        },
    },
});
