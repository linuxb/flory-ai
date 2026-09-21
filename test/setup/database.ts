import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Client} from 'pg';

/**
 * The integration suites get a database of their own, provisioned on demand.
 *
 * They used to share the development database, and that is a worker pool sharing a work queue with
 * whatever else is running. `work_queue` is global by design — one pool serves every run — so a
 * `npm run demo:coordinator` left open in another terminal claims the vertex a test just enqueued,
 * and the test fails on an assertion about leasing that has nothing to do with what broke. Nothing
 * in the test can defend against that: it is a second worker, and the queue is behaving exactly as
 * specified. Isolation is the only fix that is not a workaround.
 *
 * Provisioning runs the real `db/bootstrap.ts` and `db/migrate.ts` rather than a second copy of
 * them, so the test database is the production schema and cannot drift from it. Both are
 * idempotent, so this costs a second or two after the first run.
 */

const ROOT = resolve(import.meta.dirname, '../..');

const DEFAULT_DATABASE_URL = 'postgresql://flory:flory-dev-password@127.0.0.1:5432/flory';

/**
 * The development URL, before anything has redirected it.
 *
 * `.env` is read without being allowed to leak into this process. `loadEnvFile` has no read-only
 * mode and assigns every key it finds, and this runs inside Vitest's own process — so loading the
 * whole file changes which suites run. It did: `gateway-e2e` skips unless `GATEWAY_BASE_URL` is
 * set, and a developer with no topology up would have found nine failures where there had been
 * nine skips. Keys that were already present are left alone, because `loadEnvFile` does not
 * overwrite them.
 */
function baseDatabaseUrl(): string {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    const envFile = resolve(ROOT, '.env');
    if (!existsSync(envFile)) return DEFAULT_DATABASE_URL;
    const before = new Set(Object.keys(process.env));
    process.loadEnvFile(envFile);
    const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
    for (const key of Object.keys(process.env)) if (!before.has(key)) delete process.env[key];
    return url;
}

/**
 * Where the suites connect: the same server and credentials, a different database.
 *
 * Derived rather than configured so that pointing `DATABASE_URL` at another server moves the tests
 * with it, which is the single-variable property `db/config.ts` already promises.
 */
export function testDatabaseUrl(): string {
    const override = process.env.FLORY_TEST_DATABASE_URL;
    if (override) return override;
    const url = new URL(baseDatabaseUrl());
    const name = url.pathname.replace(/^\//, '') || 'flory';
    // Idempotent, because a test file sees `DATABASE_URL` already pointing here: deriving from it
    // a second time would ask for `flory_test_test`, which exists nowhere.
    url.pathname = name.endsWith('_test') ? name : `${name}_test`;
    return url.toString();
}

function provision(script: string, databaseUrl: string): void {
    const result = spawnSync('npx', ['tsx', script], {cwd: ROOT, env: {...process.env, DATABASE_URL: databaseUrl}, encoding: 'utf8'});
    if (result.status !== 0) {
        throw new Error(`could not prepare the test database with ${script}:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    }
}

export default async function setup(): Promise<void> {
    const databaseUrl = testDatabaseUrl();
    provision('db/bootstrap.ts', databaseUrl);
    provision('db/migrate.ts', databaseUrl);

    // Start every run from an empty queue. Files run one at a time and mostly clean up after
    // themselves, but a suite that asserts on what it can claim should not have to reason about
    // what an earlier run abandoned — and an abandoned row is claimable forever.
    const client = new Client({connectionString: databaseUrl});
    await client.connect();
    try {
        await client.query('DELETE FROM work_queue');
    } finally {
        await client.end();
    }
}
