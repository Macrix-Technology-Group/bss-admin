import { after } from 'next/server';
import type { Inquiry, InquiryEvent, InquiryMessage } from '@/lib/inquiry';
import InquiriesTable from './InquiriesTable';
import ThemeControls from './ThemeControls';

/* DEMO_DATA=1 skips the database entirely. db.ts is imported lazily inside the branch below
   rather than at the top of the file, so the flag also stops the driver being loaded and no
   connection is ever opened — the screen works with the VPN down or nothing provisioned yet. */
const DEMO = process.env.DEMO_DATA === '1';

/* Always fresh. This is a work queue — a cached page showing yesterday's inquiries is worse than
   no page, and the traffic is a handful of people in one office, so there is nothing to gain by
   caching it. */
export const dynamic = 'force-dynamic';

export default async function Page() {
    /* Fetch new mail replies on load, in the background (after the response is sent, so it never
       slows the page). This replaces the 60s background timer: mail is captured when someone opens
       or refreshes the desk. maybePoll throttles itself, so rapid refreshes don't hammer Graph. */
    if (!DEMO) {
        after(async () => {
            const { maybePoll } = await import('@/lib/mailPoll');
            await maybePoll();
        });
    }

    /* One plain SELECT. Sorting and filtering moved into the table (see InquiriesTable), so this
       no longer builds a WHERE clause per click — it loads the working set once and the browser
       does the rest. */
    let rows: Inquiry[] = [];
    let events: Record<string, InquiryEvent[]> = {};
    let messages: Record<string, InquiryMessage[]> = {};
    let dbError: string | null = null;

    try {
        if (DEMO) {
            const { DEMO_ROWS } = await import('@/lib/demo');
            rows = DEMO_ROWS;
        } else {
            const { listInquiries, listEvents, listMessages } = await import('@/lib/db');
            rows = await listInquiries({});
            /* After the list, not alongside it: which histories and conversations to fetch
               depends on which rows came back. One query each for all of them, not one per row.
               The per-status counts the tabs show come from the table's own faceted model, so
               there is no separate count query here. */
            const ids = rows.map((row) => row.id);
            [events, messages] = await Promise.all([listEvents(ids), listMessages(ids)]);
        }
    } catch (err) {
        /* The database being down is the one failure this page is likely to meet, and a stack
           trace helps nobody in sales. Say what is wrong in a sentence and keep the page up. */
        console.error('[page] query failed:', err);
        dbError = err instanceof Error ? err.message : String(err);
        rows = [];
    }


    return (
        <main className="wrap">
            <div className="head">
                <div className="brand">
                    {/* Two variants of the same mark, swapped by theme in CSS: the dark-blue one
                        is legible on the light ground, the two-tone one on the dark. Rendering
                        both and toggling with CSS keeps it flash-free — no waiting on JS to pick.
                        eslint-disable-next-line @next/next/no-img-element */}
                    <img className="brandLogo brandLogo-light" src="/bss-logisq-dark.svg" alt="BSS LogisQ" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="brandLogo brandLogo-dark" src="/bss-logisq-logo.svg" alt="" aria-hidden="true" />
                    <div className="brandDivider" aria-hidden="true" />
                    <div>
                        <h1>Inquiries</h1>
                        <p className="sub">Messages from the contact form on bss-logisq.com</p>
                    </div>
                </div>
                <div className="headRight">
                    <div className="headTools">
                        <a className="toolBtn" href="/api/export">Export CSV</a>
                        <ThemeControls />
                    </div>
                </div>
            </div>

            {/* Said plainly, because mistaking sample records for real customers would be worse
                than an ugly banner. */}
            {DEMO && (
                <div className="banner">
                    <strong>Demo data.</strong> The database is switched off — these are made-up
                    inquiries for looking at the screen. Edits are not saved.{' '}
                    <span className="muted">(unset DEMO_DATA in .env to use the real one)</span>
                </div>
            )}

            {dbError && (
                <div className="banner">
                    <strong>The database is not reachable.</strong> Nothing is lost — the website
                    keeps its own copy — but this page cannot show anything until the connection is
                    back. <span className="muted">({dbError})</span>
                </div>
            )}

            <InquiriesTable rows={rows} events={events} messages={messages} />
        </main>
    );
}
