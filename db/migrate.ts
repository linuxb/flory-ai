import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Client} from 'pg';

const adminUrl = process.env.DATABASE_URL ?? 'postgresql://flory:flory-dev-password@127.0.0.1:5432/flory';
const enginePassword = process.env.ENGINE_DB_PASSWORD ?? 'engine-dev-password';
const coordinatorPassword = process.env.COORDINATOR_DB_PASSWORD ?? 'coordinator-dev-password';

function sqlLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

const client = new Client({connectionString: adminUrl});
await client.connect();
try {
    for (const [role, password] of [
        ['engine_role', enginePassword],
        ['coordinator_role', coordinatorPassword],
    ] as const) {
        const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        if (exists.rowCount === 0) await client.query(`CREATE ROLE ${role} LOGIN PASSWORD ${sqlLiteral(password)}`);
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
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    }
} finally {
    await client.end();
}
