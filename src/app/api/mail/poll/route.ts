import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { pollOnce } from '@/lib/mailPoll';

/* Manual / cron entry point for collecting replies. The work itself lives in lib/mailPoll so the
   in-process timer (instrumentation.ts) can call the same code. Normally the timer does this on
   its own; this endpoint stays for a forced run, or for checking the mailbox from the server:
 *
 *     curl -fsS -H "x-poll-token: $POLL_TOKEN" http://127.0.0.1:3100/api/mail/poll
 */

export const dynamic = 'force-dynamic';

function tokenOk(header: string | null): boolean {
    const expected = process.env.POLL_TOKEN;
    /* Unset means unprotected, which is fine on a port bound to 127.0.0.1 and wrong anywhere
       else. Set it, and the check is real. */
    if (!expected) return true;
    if (!header) return false;

    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
    if (!tokenOk(request.headers.get('x-poll-token'))) {
        return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
    }

    try {
        return NextResponse.json(await pollOnce());
    } catch (err) {
        console.error('[mail poll] failed:', err);
        return NextResponse.json({ error: 'poll_failed' }, { status: 500 });
    }
}

/* GET does the same thing, so the curl above is plain and it can be run from a browser on the
   server while setting the mailbox up. */
export const GET = POST;
