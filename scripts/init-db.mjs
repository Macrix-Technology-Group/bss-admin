/* Applies db/schema.sql.
 *
 * Safe to run on every container start: every statement in the schema file is IF NOT EXISTS, so an
 * existing database is left exactly as it was. That is what removes the "did anyone remember to run
 * migrations" question from deployment.
 *
 * It retries rather than assuming the database is reachable, so a container that starts before the
 * network is up waits it out instead of crash-looping.
 *
 * The whole file is sent in one query: node-postgres runs a multi-statement string in a single
 * call, and `--` comments are handled by the server, so there is no need to split on semicolons.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

/* Next loads .env itself; a plain node script does not. In a container the values come from the
   environment, so dotenv is optional — load it if present, ignore it if not. */
try {
    await import('dotenv/config');
} catch {
    /* no dotenv in this environment — env vars are already set */
}

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
}

const ATTEMPTS = 30;
const GAP_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const schema = await readFile(join(here, '..', 'db', 'schema.sql'), 'utf8');

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const client = new pg.Client({
        /* Strip sslmode so the ssl option decides TLS — Supabase's pooler cert will not chain
           on its own, so we encrypt without verifying the chain. */
        connectionString: process.env.DATABASE_URL.replace(/([?&])sslmode=[^&]*/g, '$1').replace(/[?&]+$/, ''),
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10_000,
    });
    try {
        await client.connect();
        await client.query(schema);
        await client.end();
        console.log('Schema is up to date.');
        process.exit(0);
    } catch (err) {
        await client.end().catch(() => {});
        if (attempt === ATTEMPTS) {
            console.error(`Could not reach the database after ${ATTEMPTS} attempts:`, err.message);
            process.exit(1);
        }
        console.log(`Database not ready (attempt ${attempt}/${ATTEMPTS}) — retrying in ${GAP_MS / 1000}s`);
        await sleep(GAP_MS);
    }
}
