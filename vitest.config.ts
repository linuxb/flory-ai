import {defineConfig} from 'vitest/config';
import {testDatabaseUrl} from './test/setup/database.js';

export default defineConfig({
    test: {
        // The suites run against their own database, provisioned by the global setup below. They
        // used to share the development one, where a Coordinator left running in another terminal
        // claims from the same global work queue and makes leasing assertions fail for reasons
        // that have nothing to do with the code under test.
        globalSetup: ['test/setup/database.ts'],
        env: {DATABASE_URL: testDatabaseUrl()},
        // Still one database for every file, and `work_queue` is global within it, so one suite's
        // queued work is claimable by another's assertions. Files run one at a time.
        fileParallelism: false,
    },
});
