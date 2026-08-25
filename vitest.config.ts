import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        // The integration suites share one PostgreSQL database, including one global
        // work queue that is global by design because one worker pool serves every
        // run. Running test files in parallel would let one suite's queued work be
        // claimed by another's assertions, so files run one at a time.
        fileParallelism: false,
    },
});
