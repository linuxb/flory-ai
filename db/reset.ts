import {Client} from 'pg';
import {databaseUrl, ownerTarget, quoteIdentifier} from './config.js';

/**
 * Drops and recreates the public schema of the configured database. Local servers are often shared
 * with unrelated projects, so this refuses to run against a PostgreSQL maintenance database or a
 * populated database that carries no Flory migration marker.
 */
const owner = ownerTarget();
const maintenance = new Set(['postgres', 'template0', 'template1']);
if (maintenance.has(owner.database)) throw new Error(`refusing to reset the PostgreSQL maintenance database ${owner.database}; point DATABASE_URL at the Flory database`);

const client = new Client({connectionString: databaseUrl});
await client.connect();
try {
    const tables = await client.query<{count: string}>("SELECT count(*) AS count FROM pg_tables WHERE schemaname = 'public'");
    const marker = await client.query("SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('schema_migration', 'event_log')");
    if (Number(tables.rows[0]!.count) > 0 && marker.rowCount === 0) {
        throw new Error(`refusing to reset ${owner.database} at ${owner.host}:${owner.port}: it holds tables but no Flory migration marker, so it is probably another project's database`);
    }
    await client.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ${quoteIdentifier(owner.role)}; GRANT ALL ON SCHEMA public TO public;`);
    console.log(`reset the public schema of ${owner.database} at ${owner.host}:${owner.port}`);
} finally {
    await client.end();
}
