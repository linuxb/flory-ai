import {Client} from 'pg';

const client = new Client({connectionString: process.env.DATABASE_URL ?? 'postgresql://flory:flory-dev-password@127.0.0.1:5432/flory'});
await client.connect();
try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO flory; GRANT ALL ON SCHEMA public TO public;');
} finally {
    await client.end();
}
