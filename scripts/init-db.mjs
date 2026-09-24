/* Applies db/schema.sql.
 *
 * Safe to run on every container start: every statement in the schema file is IF NOT EXISTS, so an
 * existing database is left exactly as it was. That is what removes the "did anyone remember to run
 * migrations" question from deployment.
 *
 * It retries rather than assuming the database is reachable. Neon suspends an idle free-plan
 * database and takes a second or two to wake, and a container starting before the network is up
 * would otherwise crash-loop through that window and look like a failed deployment.
 *
 * ── Note for anyone who knew the MariaDB version ──
 * The driver speaks HTTP, and one request carries one statement — there is no multipleStatements
 * to switch on. So the file is split on semicolons at the end of a line and sent statement by
 * statement. That works because the schema is deliberately plain DDL: no function bodies, no
 * DO blocks, nothing with an internal semicolon. Keep it that way.
 */
/* Next loads .env by itself; a plain node script does not. Missing file is not an error — in a
   container the values come from the environment rather than a file. */
import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
}

const ATTEMPTS = 30;
const GAP_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Strip comment-only lines before splitting: a `--` comment containing a semicolon would
   otherwise end a statement in the middle of itself. */
function statements(text) {
    return text
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(/;\s*$/m)
        .map((s) => s.trim())
        .filter(Boolean);
}

const sql = neon(process.env.DATABASE_URL);
const schema = statements(await readFile(join(here, '..', 'db', 'schema.sql'), 'utf8'));

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
        for (const statement of schema) await sql.query(statement);
        console.log(`Schema is up to date (${schema.length} statements).`);
        process.exit(0);
    } catch (err) {
        if (attempt === ATTEMPTS) {
            console.error(`Could not reach the database after ${ATTEMPTS} attempts:`, err.message);
            process.exit(1);
        }
        console.log(`Database not ready (attempt ${attempt}/${ATTEMPTS}) — retrying in ${GAP_MS / 1000}s`);
        await sleep(GAP_MS);
    }
}
