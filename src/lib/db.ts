import { Pool, type PoolClient } from 'pg';
import type { Inquiry, InquiryEvent, InquiryMessage } from './inquiry';

export { STATUSES } from './inquiry';
export type { Inquiry, InquiryStatus, InquiryEvent, InquiryMessage } from './inquiry';

/* The database is Supabase — managed Postgres, reached over a normal connection through Supabase's
 * pooler. The desk runs as one long-lived container, so a connection pool is the right shape: it
 * keeps a few connections warm and hands them out per query, rather than opening one each time.
 *
 * The pool is created lazily on first use, not at import: `next build` evaluates this module
 * without DATABASE_URL in scope, and building the pool eagerly would fail the build before a page
 * renders. It is cached on globalThis so Next's dev-server reloads reuse one pool instead of
 * leaking a new one on every edit.
 */
type Row = Record<string, unknown>;
type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;

const g = globalThis as unknown as { __pgPool?: Pool };

function pool(): Pool {
    if (!g.__pgPool) {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL is not set — copy .env.example to .env');
        g.__pgPool = new Pool({
            /* Strip any sslmode from the URL so the ssl option below is what decides TLS. Supabase's
               pooler presents a cert Node will not chain to on its own ("self-signed in chain"); the
               connection is still encrypted, just not chain-verified. */
            connectionString: url.replace(/([?&])sslmode=[^&]*/g, '$1').replace(/[?&]+$/, ''),
            /* Small pool — one container, a handful of people. */
            max: 3,
            /* Close our own idle connections after 1 second. Between page loads the pool is then
               empty, so the next request opens a FRESH (guaranteed live) connection rather than
               reusing one Supabase's pooler may have dropped. This is what stops the post-idle
               freeze at the source; the health-check in sql() covers the rare gap. */
            idleTimeoutMillis: 1_000,
            connectionTimeoutMillis: 10_000,
            /* Hard cap on any query, as a last resort. */
            query_timeout: 6_000,
            statement_timeout: 6_000,
            /* TCP keepalive, so the OS notices a dropped socket sooner rather than waiting it out. */
            keepAlive: true,
            keepAliveInitialDelayMillis: 5_000,
            /* The connection is TLS; the pooler presents a valid cert but not always a chain node
               can verify, so encrypt without failing on the chain. */
            ssl: { rejectUnauthorized: false },
        });
    }
    return g.__pgPool;
}

/* A tagged-template query that keeps the call sites unchanged: `await sql`SELECT … ${value}`` still
   parameterises each ${value} as a bound argument ($1, $2, …) and resolves to the rows. This is the
   same shape the Neon driver exposed, so nothing else in this file had to change. */
/* Rejects if `p` has not settled within `ms` — a hard cap independent of pg's own timeouts, so a
   connection wedged at the socket level can never hang a request longer than this. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
    ]);
}

/* A connection that has just answered a `SELECT 1` — i.e. proven alive THIS instant. A dead one
   (Supabase closed it while it sat in the pool) fails the check within 2s and is destroyed so it
   leaves the pool; the next attempt gets another, and within a few tries lands on a live one. This
   is what makes a hang impossible: the real query only ever runs on a connection we just verified. */
async function liveClient(p: Pool): Promise<PoolClient> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
        const client = await withTimeout(p.connect(), 8_000, 'connect');
        try {
            await withTimeout(client.query('SELECT 1'), 2_000, 'health check');
            return client;
        } catch (err) {
            client.release(true); // destroy the dead/wedged connection
            lastErr = err;
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error('database unreachable');
}

export function sql(): SqlTag {
    const p = pool();
    return async (strings, ...values) => {
        let text = '';
        strings.forEach((part, i) => {
            text += part;
            if (i < values.length) text += `$${i + 1}`;
        });

        const client = await liveClient(p);
        try {
            const res = await client.query(text, values);
            client.release();
            return res.rows as Row[];
        } catch (err) {
            client.release(true);
            throw err;
        }
    };
}

/* ── Reading the list ──────────────────────────────────────────────────────
   One plain SELECT. Sorting and filtering live in the table component, so this does not build a
   WHERE clause per click — it loads the working set once.

   source_ip is excluded deliberately: it is kept for abuse handling, and the people using this
   screen have no reason to see visitors' IP addresses. */
export async function listInquiries(opts: { limit?: number } = {}): Promise<Inquiry[]> {
    const limit = Math.min(Math.max(Number(opts.limit ?? 500) | 0, 1), 10_000);

    const rows = await sql()`
        SELECT id, first_name, last_name, company, email, subject, message, phone,
               consent_given, privacy_version, locale, status, assignee, notes,
               received_at, updated_at
          FROM inquiries
         ORDER BY received_at DESC
         LIMIT ${limit}
    ` as Record<string, unknown>[];

    return rows.map((r) => ({
        ...r,
        /* BIGSERIAL arrives as a string and the UI keys rows by it, so say so rather than relying
           on that staying true. */
        id: String(r.id),
        /* TIMESTAMPTZ comes back as an instant, so one toISOString() is the whole conversion —
           the MariaDB version had to append a 'Z' by hand because DATETIME carried no zone. */
        received_at: new Date(r.received_at as string).toISOString(),
        updated_at: new Date(r.updated_at as string).toISOString(),
    })) as Inquiry[];
}

/* ── History ───────────────────────────────────────────────────────────────
   Every change the team makes is recorded, and this reads it back for the whole page in one
   query rather than one per row: each query here is an HTTPS request, so 500 rows asking
   individually is the difference between a page and a stall. */
export async function listEvents(inquiryIds: string[]): Promise<Record<string, InquiryEvent[]>> {
    if (inquiryIds.length === 0) return {};

    const rows = await sql()`
        SELECT id, inquiry_id, at, actor, field, from_value, to_value
          FROM inquiry_events
         WHERE inquiry_id = ANY(${inquiryIds}::bigint[])
         ORDER BY at DESC
    ` as Record<string, unknown>[];

    const grouped: Record<string, InquiryEvent[]> = {};

    for (const row of rows) {
        const event: InquiryEvent = {
            id: String(row.id),
            inquiry_id: String(row.inquiry_id),
            at: new Date(row.at as string).toISOString(),
            actor: (row.actor as string) ?? null,
            field: row.field as string,
            from_value: (row.from_value as string) ?? null,
            to_value: (row.to_value as string) ?? null,
        };

        (grouped[event.inquiry_id] ??= []).push(event);
    }

    return grouped;
}

/* ── The conversation ──────────────────────────────────────────────────────
   Read the same way as the history: once for the whole page, keyed by inquiry. */
export async function listMessages(
    inquiryIds: string[],
): Promise<Record<string, InquiryMessage[]>> {
    if (inquiryIds.length === 0) return {};

    const rows = await sql()`
        SELECT id, inquiry_id, at, direction, from_addr, to_addr, actor, subject, body
          FROM inquiry_messages
         WHERE inquiry_id = ANY(${inquiryIds}::bigint[])
         ORDER BY at ASC
    ` as Record<string, unknown>[];

    const grouped: Record<string, InquiryMessage[]> = {};

    for (const row of rows) {
        const message: InquiryMessage = {
            id: String(row.id),
            inquiry_id: String(row.inquiry_id),
            at: new Date(row.at as string).toISOString(),
            direction: row.direction as 'out' | 'in',
            from_addr: row.from_addr as string,
            to_addr: row.to_addr as string,
            actor: (row.actor as string) ?? null,
            subject: row.subject as string,
            body: row.body as string,
        };

        (grouped[message.inquiry_id] ??= []).push(message);
    }

    return grouped;
}

/* Returns false if the message was already stored — the unique index on message_id is what makes
   the poller safe to run twice over the same mail. */
export async function recordMessage(m: {
    inquiryId: string;
    direction: 'out' | 'in';
    from: string;
    to: string;
    actor?: string | null;
    subject: string;
    body: string;
    messageId?: string | null;
    inReplyTo?: string | null;
    at?: string | null;
}): Promise<boolean> {
    const rows = await sql()`
        INSERT INTO inquiry_messages
            (inquiry_id, at, direction, from_addr, to_addr, actor, subject, body,
             message_id, in_reply_to)
        VALUES
            (${m.inquiryId}, ${m.at ?? new Date().toISOString()}, ${m.direction}, ${m.from},
             ${m.to}, ${m.actor ?? null}, ${m.subject}, ${m.body},
             ${m.messageId ?? null}, ${m.inReplyTo ?? null})
        /* The WHERE is not optional: the unique index is partial (message_id IS NOT NULL), and
           Postgres will not match a partial index to an ON CONFLICT target unless the predicate
           is repeated here. Without it every insert fails with "no unique or exclusion
           constraint matching the ON CONFLICT specification". */
        ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING
        RETURNING id
    ` as { id: string }[];

    return rows.length > 0;
}

/* The primary match for a reply: its In-Reply-To / References header names the outgoing mail it
   answers by Message-ID, and that mail is in this table with the inquiry it belongs to. */
export async function inquiryByMessageId(messageId: string): Promise<string | null> {
    const rows = await sql()`
        SELECT inquiry_id FROM inquiry_messages WHERE message_id = ${messageId} LIMIT 1
    ` as { inquiry_id: string }[];

    return rows[0] ? String(rows[0].inquiry_id) : null;
}

/* Confirms an inquiry id is real before a reply is filed against it. Used by the subject-tag
   fallback, where the id comes from text a customer could edit — a made-up [BSS-MX-999] must not
   create a phantom thread. */
export async function inquiryExists(inquiryId: string): Promise<boolean> {
    const rows = await sql()`
        SELECT 1 FROM inquiries WHERE id = ${inquiryId} LIMIT 1
    ` as unknown[];

    return rows.length > 0;
}

/* An event written by something other than a person at the desk — currently the mail poller,
   noting a bounce or an out-of-office. Same table as the team's own changes, because "what has
   happened to this inquiry" is one list, not two. */
export async function recordEvent(
    inquiryId: string,
    field: string,
    from: string | null,
    to: string | null,
    actor: string | null = 'mail',
): Promise<void> {
    await sql()`
        INSERT INTO inquiry_events (inquiry_id, actor, field, from_value, to_value)
        VALUES (${inquiryId}, ${actor}, ${field}, ${from}, ${to})
    `;
}
