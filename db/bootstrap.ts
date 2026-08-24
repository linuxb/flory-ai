import {Client} from 'pg';
import {adminClientConfig, coordinatorPassword, enginePassword, ownerTarget, quoteIdentifier, quoteLiteral} from './config.js';

/**
 * Provisions the cluster-level objects Flory needs: the owner role from `DATABASE_URL`, the two
 * application roles, and the database itself. Roles and databases are cluster-wide, so this is the
 * one administrative step; migrations afterwards run as the owner and touch only that database.
 * It is idempotent and creates nothing else, which is what makes a local server shared with other
 * projects safe to use.
 */
const owner = ownerTarget();
const admin = new Client(adminClientConfig());
try {
    await admin.connect();
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
        `cannot reach PostgreSQL at ${owner.host}:${owner.port} with administrative credentials (${detail}). ` +
            'Set FLORY_ADMIN_DATABASE_URL to a superuser connection on that server, or start the optional container with `npm run db:up`.',
    );
}
try {
    for (const [role, password] of [
        [owner.role, owner.password],
        ['engine_role', enginePassword],
        ['coordinator_role', coordinatorPassword],
    ] as const) {
        const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        if (exists.rowCount === 0) {
            await admin.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`);
            console.log(`created role ${role}`);
        } else {
            await admin.query(`ALTER ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`);
            console.log(`role ${role} already exists; synchronized its login password with the configured value`);
        }
    }
    const database = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [owner.database]);
    if (database.rowCount === 0) {
        await admin.query(`CREATE DATABASE ${quoteIdentifier(owner.database)} OWNER ${quoteIdentifier(owner.role)}`);
        console.log(`created database ${owner.database} owned by ${owner.role}`);
    } else {
        console.log(`database ${owner.database} already exists; leaving it untouched`);
    }
} finally {
    await admin.end();
}
console.log(`bootstrap complete for ${owner.role}@${owner.host}:${owner.port}/${owner.database}; run \`npm run db:migrate\` next`);
