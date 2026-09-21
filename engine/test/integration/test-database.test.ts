import {describe, expect, it} from 'vitest';
import {Client} from 'pg';
import {databaseUrl} from '../../../db/config.js';
import {testDatabaseUrl} from '../../../test/setup/database.js';

/**
 * The suites must not be sharing a database with anything that runs on its own.
 *
 * `work_queue` is global by design — one worker pool serves every run — so a Coordinator left
 * running in another terminal is a second worker competing for the rows a test just enqueued.
 * Nothing inside a test can defend against that, and the failure it produces is an assertion about
 * leasing rather than about whatever actually broke. This asserts the isolation instead of trusting
 * that the configuration stays as written.
 */
describe('the database these suites run against', () => {
    it('is the dedicated test database, not the development one', () => {
        expect(new URL(databaseUrl).pathname).toMatch(/_test$/);
        // And the helper agrees from in here, which it only does because it is idempotent: a test
        // file already sees `DATABASE_URL` pointing at the test database.
        expect(testDatabaseUrl()).toBe(databaseUrl);
    });

    it('carries the production schema, because it was provisioned by the production migrations', async () => {
        // Provisioning runs `db/bootstrap.ts` and `db/migrate.ts` rather than a second copy of
        // them, so a schema a migration introduced cannot be missing here and present in
        // development. The newest trigger is the cheapest thing to check for.
        const client = new Client({connectionString: databaseUrl});
        await client.connect();
        try {
            // One per partition plus the parent, because `run_event_log` is partitioned and a row
            // trigger propagates. The count is incidental; its presence is the point.
            const triggers = await client.query<{tgname: string}>("SELECT tgname FROM pg_trigger WHERE tgname = 'run_event_log_dequeue_shadowed'");
            expect(triggers.rows.length).toBeGreaterThan(0);
        } finally {
            await client.end();
        }
    });
});
