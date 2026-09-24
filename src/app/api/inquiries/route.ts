import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { timingSafeEqual } from 'node:crypto';

/* The website posts here. This is the ONE door into this application from outside, so it is the
   one place that has to be defended.

   The screen itself has no login — that is a deliberate decision on the basis that this app is
   only reachable from inside the Macrix network. That decision covers READING. It cannot cover
   WRITING: an unauthenticated write endpoint lets anyone who can reach it fill the team's desk
   with fabricated inquiries, and nothing in the UI would distinguish those from real ones. So a
   shared token is required here regardless.

   Not a login, and not a substitute for one — one secret, held by the website, identifying a
   machine rather than a person. */

export const dynamic = 'force-dynamic';

function tokenOk(header: string | null): boolean {
    const expected = process.env.INGEST_TOKEN;
    if (!expected || !header) return false;

    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    /* Compare in constant time. Lengths differing is itself a leak through timingSafeEqual's
       throw, so that case is answered before the comparison rather than by it. */
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/* Trim and cap every string before it reaches the database. The columns are TEXT, so without a
   cap a single request could store megabytes; these limits are far above any real inquiry and far
   below anything that would matter. */
const clean = (v: unknown, max: number): string =>
    typeof v === 'string' ? v.trim().slice(0, max) : '';

export async function POST(request: NextRequest) {
    if (!tokenOk(request.headers.get('x-ingest-token'))) {
        /* 401 with no detail: a caller without the token learns only that it was refused, not
           whether the token was missing, wrong, or the server misconfigured. */
        return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }

    const firstName = clean(body.firstName, 200);
    const lastName = clean(body.lastName, 200);
    const company = clean(body.company, 300);
    const email = clean(body.email, 320); // 320 = the maximum length of an email address
    const subject = clean(body.subject, 300);
    const message = clean(body.message, 20_000);
    const phone = clean(body.phone, 60) || null;

    if (!firstName || !lastName || !company || !email || !subject || !message) {
        return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
    }

    try {
        const rows = await sql()`
            INSERT INTO inquiries
                (first_name, last_name, company, email, subject, message, phone,
                 consent_given, privacy_version, locale, source_ip)
            VALUES (
                ${firstName},
                ${lastName},
                ${company},
                ${email},
                ${subject},
                ${message},
                ${phone},
                ${body.consentGiven !== false},
                ${clean(body.privacyVersion, 40) || null},
                ${clean(body.locale, 10) || null},
                ${
                    /* Behind a reverse proxy the socket address is the proxy, so the forwarded
                       header is the only way to see the real client. It is attacker-controlled,
                       which is fine for the one thing it is used for — looking into abuse after
                       the fact — and is why it is never shown as fact in the UI. */
                    (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null
                }
            )
            RETURNING id
        ` as { id: string }[];

        return NextResponse.json({ success: true, id: String(rows[0].id) }, { status: 201 });
    } catch (err) {
        /* Logged for the operator, not returned: the message can contain connection strings. */
        console.error('[ingest] insert failed:', err);
        return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
}
