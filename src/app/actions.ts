'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { STATUSES, type InquiryStatus } from '@/lib/inquiry';

/* With DEMO_DATA=1 there is no database to write to, so every write is a no-op. The controls stay
   usable so the screen can still be judged as a whole; without this guard each click would throw
   on a connection that was deliberately never opened.

   The client is reached through a lazy import for the same reason as in page.tsx — in demo mode
   the driver must not be loaded at all. */
const DEMO = process.env.DEMO_DATA === '1';
const db = async () => (await import('@/lib/db')).sql();

/* Server actions for the three things the team does to an inquiry: move its status, put a name
   against it, and write a note.

   Each one validates its own input. A server action is a real HTTP endpoint — the form it is
   attached to is not a guarantee about what arrives — so `status` is checked against the known
   list rather than trusted and handed to the database, where the CHECK constraint would turn it
   into a 500 instead of a handled no-op.

   Values are interpolated into a tagged template, which the driver sends as bound parameters —
   never concatenated into the statement. */

const VALID = new Set(STATUSES.map((s) => s.value));

/* Who made the change, for the history. The desk has no login — it is reachable only from inside
   the network — so the best available answer is the address it came from. When a sign-in is
   added, the account goes here instead and old rows stay readable. */
async function actor(): Promise<string | null> {
    const list = await headers();
    return list.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

/* Every change is written twice: to the row, so the list is current, and to inquiry_events, so
   the row's past is not overwritten by its present.

   The two are separate statements over HTTP and cannot share a transaction without an extra
   round trip. Ordered so the worst case is a change recorded but not applied, never a change
   applied but not recorded.

   Each update is spelled out rather than built from a column name held in a variable: the driver
   binds values, not identifiers, so a shared helper would have to splice the column into the
   statement as text. Three short statements are worth more than the one that would need that. */
async function record(
    id: string,
    field: 'status' | 'assignee' | 'notes',
    from: string | null,
    to: string | null,
) {
    const sql = await db();
    await sql`
        INSERT INTO inquiry_events (inquiry_id, actor, field, from_value, to_value)
        VALUES (${id}, ${await actor()}, ${field}, ${from}, ${to})
    `;
}

/* Each update runs only if the value actually differs, and returns the value it replaced in the
   same statement. Nothing coming back means nothing changed — which is how pressing Save on an
   unchanged control avoids writing a history entry saying so. */
export async function setStatus(id: string, status: string) {
    if (!VALID.has(status as InquiryStatus)) return;
    if (DEMO) return;

    const sql = await db();
    const changed = await sql`
        UPDATE inquiries
           SET status = ${status}, updated_at = now()
         WHERE id = ${id} AND status IS DISTINCT FROM ${status}
        RETURNING (SELECT status FROM inquiries WHERE id = ${id}) AS previous
    ` as { previous: string | null }[];

    if (changed.length > 0) await record(id, 'status', changed[0].previous, status);

    revalidatePath('/');
}

export async function setAssignee(id: string, assignee: string) {
    const value = assignee.trim().slice(0, 120) || null;
    if (DEMO) return;

    const sql = await db();
    const changed = await sql`
        UPDATE inquiries
           SET assignee = ${value}, updated_at = now()
         WHERE id = ${id} AND assignee IS DISTINCT FROM ${value}
        RETURNING (SELECT assignee FROM inquiries WHERE id = ${id}) AS previous
    ` as { previous: string | null }[];

    if (changed.length > 0) await record(id, 'assignee', changed[0].previous, value);

    revalidatePath('/');
}

export async function setNotes(id: string, notes: string) {
    const value = notes.trim().slice(0, 5_000) || null;
    if (DEMO) return;

    const sql = await db();
    const changed = await sql`
        UPDATE inquiries
           SET notes = ${value}, updated_at = now()
         WHERE id = ${id} AND notes IS DISTINCT FROM ${value}
        RETURNING (SELECT notes FROM inquiries WHERE id = ${id}) AS previous
    ` as { previous: string | null }[];

    if (changed.length > 0) await record(id, 'notes', changed[0].previous, value);

    revalidatePath('/');
}

/* ── Replying to the customer ──────────────────────────────────────────────
   Sends from the shared mailbox, stores the mail in the thread, and notes it in the history. The
   send happens first: a mail recorded but never sent is a lie the team would act on, whereas a
   mail sent but not recorded shows up as the customer's reply quoting something the desk cannot
   find — visible, and recoverable from the mailbox.

   Marks the inquiry answered in the same step. Someone who has just written a reply should not
   have to remember a dropdown as well, and in the history it reads as one action. */
export async function sendReply(id: string, subject: string, body: string) {
    if (DEMO) return { ok: false, error: 'Demo mode — nothing is sent.' };

    const text = body.trim();
    if (!text) return { ok: false, error: 'Nothing to send.' };

    const { sendMail } = await import('@/lib/mail');
    const { recordMessage } = await import('@/lib/db');
    const sql = await db();

    const rows = await sql`
        SELECT email, assignee FROM inquiries WHERE id = ${id}
    ` as { email: string; assignee: string | null }[];
    if (!rows[0]) return { ok: false, error: 'That inquiry no longer exists.' };

    const line = subject.trim().slice(0, 300) || 'Your inquiry';
    const who = await actor();

    try {
        const sent = await sendMail({
            inquiryId: id,
            to: rows[0].email,
            subject: line,
            body: text,
            /* The signature is signed by whoever is handling the inquiry; unassigned mail goes out
               from the Sales Team. */
            signerName: rows[0].assignee ?? 'Sales Team',
        });

        await recordMessage({
            inquiryId: id,
            direction: 'out',
            from: sent.from,
            to: rows[0].email,
            actor: who,
            subject: line,
            body: text,
            messageId: sent.messageId,
        });
    } catch (err) {
        /* The reason goes to the operator's log; the person at the desk gets a sentence they can
           act on, because the useful next step is always "tell whoever set up the mailbox". */
        console.error('[reply] send failed:', err);
        return { ok: false, error: 'The mail could not be sent. Nothing was saved.' };
    }

    await setStatus(id, 'answered');
    revalidatePath('/');

    return { ok: true };
}
