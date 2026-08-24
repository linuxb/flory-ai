import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ClientConfig} from 'pg';

/**
 * One source of truth for local database connection settings, shared by the migration utilities and
 * the TypeScript integration tests. Every connection is derived from `DATABASE_URL`, so pointing the
 * repository at an already-running PostgreSQL server — a different host, port, or database name —
 * is a single-variable change. Go services read the same variables from the process environment.
 */
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** The owner connection: the role that owns the Flory database and applies migrations. */
export const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://flory:flory-dev-password@127.0.0.1:5432/flory';
/** Login password for the engine application role. */
export const enginePassword = process.env.ENGINE_DB_PASSWORD ?? 'engine-dev-password';
/** Login password for the Coordinator application role. */
export const coordinatorPassword = process.env.COORDINATOR_DB_PASSWORD ?? 'coordinator-dev-password';

/** The database owner and target database named by {@link databaseUrl}. */
export interface OwnerTarget {
    role: string;
    password: string;
    database: string;
    host: string;
    port: number;
}

function parsed(url: string): URL {
    try {
        return new URL(url);
    } catch {
        throw new Error(`DATABASE_URL is not a valid connection URL: ${url}`);
    }
}

/** Reads the owner role, password, database, host, and port encoded in {@link databaseUrl}. */
export function ownerTarget(): OwnerTarget {
    const url = parsed(databaseUrl);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!url.username || !database) throw new Error('DATABASE_URL must name both a role and a database');
    return {
        role: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database,
        host: url.hostname || '127.0.0.1',
        port: url.port ? Number(url.port) : 5432,
    };
}

function withCredentials(role: string, password: string): string {
    const url = parsed(databaseUrl);
    url.username = encodeURIComponent(role);
    url.password = encodeURIComponent(password);
    return url.toString();
}

/** Engine-role connection, following {@link databaseUrl}'s host, port, and database by default. */
export const engineDatabaseUrl = process.env.ENGINE_DATABASE_URL ?? withCredentials('engine_role', enginePassword);
/** Coordinator-role connection, following {@link databaseUrl}'s host, port, and database by default. */
export const coordinatorDatabaseUrl = process.env.COORDINATOR_DATABASE_URL ?? withCredentials('coordinator_role', coordinatorPassword);

/**
 * Connection used to provision cluster-level objects: the owner role, the application roles, and the
 * database. Resolution order is `FLORY_ADMIN_DATABASE_URL`, then the standard libpq environment
 * (`PGUSER`/`PGPASSWORD`), then the owner credentials themselves against the maintenance database —
 * which is what the container path and CI use, because there the owner is already a superuser.
 */
export function adminClientConfig(): ClientConfig {
    if (process.env.FLORY_ADMIN_DATABASE_URL) return {connectionString: process.env.FLORY_ADMIN_DATABASE_URL};
    const owner = ownerTarget();
    const database = process.env.PGDATABASE ?? 'postgres';
    if (process.env.PGUSER) return {host: owner.host, port: owner.port, database, user: process.env.PGUSER, password: process.env.PGPASSWORD};
    return {host: owner.host, port: owner.port, database, user: owner.role, password: owner.password};
}

/** Quotes a SQL identifier so a configured role or database name cannot inject SQL. */
export function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

/** Quotes a SQL string literal, used for role passwords that cannot be parameterized. */
export function quoteLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}
