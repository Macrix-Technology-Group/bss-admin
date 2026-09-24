import { neon } from '@neondatabase/serverless';
import type { Inquiry, InquiryEvent, InquiryMessage } from './inquiry';

export { STATUSES } from './inquiry';
export type { Inquiry, InquiryStatus, InquiryEvent, InquiryMessage } from './inquiry';

/* The database is Neon — managed Postgres, reached over HTTPS rather than a socket.
 *
 * That removes the assumption this file used to be built on. There is no pool to keep alive and
 * nothing to leak across dev-server reloads, because each query is an HTTPS request: the
 * globalThis cache the MariaDB pool needed is gone, and so is the failure it guarded against.
 * What replaces it is one client object, created on first use.
 *
 * Lazily, not at import: `next build` evaluates this module without DATABASE_URL in scope, and
 * neon() throws on an empty connection string — eagerly, that fails the build before a single
 * page renders.
 */
let client: ReturnType<typeof neon> | null = null;

export function sql() {
    if (!client) {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL is not set — copy .env.example to .env');
        client = neon(url);
    }
    return client;
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
