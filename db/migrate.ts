import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Client} from 'pg';
import {databaseUrl, ownerTarget} from './config.js';

/**
 * Applies pending migrations as the database owner. Roles and the database itself are cluster-level
 * objects provisioned by `npm run db:bootstrap`, so this step needs no administrative privilege and
 * writes only inside the configured database.
 */
const owner = ownerTarget();
const client = new Client({connectionString: databaseUrl});
try {
    await client.connect();
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot connect to ${owner.database} at ${owner.host}:${owner.port} as ${owner.role} (${detail}). Run \`npm run db:bootstrap\` first if the role or database does not exist yet.`);
}
try {
    for (const role of ['engine_role', 'coordinator_role']) {
        const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        if (exists.rowCount === 0) throw new Error(`application role ${role} does not exist; run \`npm run db:bootstrap\` to provision the Flory roles`);
    }
    await client.query('CREATE TABLE IF NOT EXISTS schema_migration (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const applied = new Set((await client.query<{version: string}>('SELECT version FROM schema_migration')).rows.map((row) => row.version));
    for (const file of (await readdir(join(process.cwd(), 'db/migrations'))).filter((name) => name.endsWith('.sql')).sort()) {
        if (applied.has(file)) continue;
        await client.query('BEGIN');
        try {
            await client.query(await readFile(join(process.cwd(), 'db/migrations', file), 'utf8'));
            await client.query('INSERT INTO schema_migration(version) VALUES ($1)', [file]);
            await client.query('COMMIT');
            console.log(`applied ${file}`);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    }
} finally {
    await client.end();
}
