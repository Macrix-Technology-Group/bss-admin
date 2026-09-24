import sanitizeHtml from 'sanitize-html';
import { unreadMail, markRead, inquiryIdFromSubject, type IncomingMail } from './mail';
import { recordMessage, recordEvent, inquiryByMessageId, inquiryExists } from './db';

/* Collecting replies from the shared mailbox and filing them against the inquiry they answer.
 *
 * This is the work; it is called both by the /api/mail/poll endpoint (for a cron, or a manual
 * curl) and by the in-process timer in instrumentation.ts. Because the desk runs as a single
 * long-lived container, the timer is a reliable place for it — the caveat in the old route comment
 * about serverless does not apply here.
 *
 * MAIL NOT BELONGING TO AN INQUIRY IS LEFT ALONE — not read, not marked, not copied. A reply to an
 * inquiry is the only thing taken from the mailbox.
 */

/* Turns the customer's reply into safe HTML for storage and display. The WHOLE message is kept —
   text, formatting, links, images and their signature — because nothing they wrote should be
   missing. What sanitising removes is only the parts that could run code: <script>, <style>, event
   handlers (onclick and the like), and non-http/mailto links. So the message is shown exactly as
   sent, minus the danger.
 *
 * Plain-text replies (rare from Outlook) are escaped and their line breaks kept, so they render the
 * same way without being treated as markup. */
/* Cuts an HTML reply at the point the signature or the quoted original begins, keeping only what
   the customer actually typed. The markers are the containers Outlook and Gmail wrap those in — a
   signature div, the "forwarded/reply" block, a gmail_quote, a blockquote. Cutting mid-document
   can leave tags open; that is fine, because sanitize-html re-serialises valid HTML afterwards and
   closes them. */
function stripQuotedHtml(html: string): string {
    let cut = html.length;

    /* Container wrappers — cut at where the element opens. */
    const containers = [
        /<div[^>]*id=["']?Signature/i,
        /<div[^>]*id=["']?divRplyFwdMsg/i,
        /<div[^>]*id=["']?appendonsend/i,
        /<div[^>]*class=["'][^"']*gmail_quote/i,
        /<div[^>]*class=["'][^"']*OutlookMessageHeader/i,
        /<blockquote/i,
        /<hr[^>]*id=["']?stopSpelling/i,
    ];
    for (const m of containers) {
        const at = html.search(m);
        if (at !== -1 && at < cut) cut = at;
    }

    /* Sign-off and quoted-original phrases — these are plain text inside the HTML, not wrapped in
       any tell-tale container, so they are found by phrase. The cut is moved back to the start of
       the element the phrase sits in (the last "<" before it), so a partial tag is not left
       dangling. Partial phrases, to dodge entity-encoded umlauts. */
    const phrases = [
        /Mit freundlichen Gr/i, /Viele Gr[uü]/i, /Freundliche Gr/i, /Beste Gr[uü]/i,
        /Best regards/i, /Kind regards/i, /Best wishes/i, /\bRegards\b/i, /Sincerely/i,
        /Pozdrawiam/i, /Z powa[zż]/i,
        /On .{0,80}wrote:/i, /Am .{0,80}schrieb.{0,80}:/i, /-{3,}\s*Original Message/i,
        /Von:\s*.{0,80}Gesendet:/i,
    ];
    for (const m of phrases) {
        const at = html.search(m);
        if (at === -1) continue;
        const tagStart = html.lastIndexOf('<', at);
        const c = tagStart !== -1 ? tagStart : at;
        if (c < cut) cut = c;
    }

    return html.slice(0, cut);
}

/* The same for a plain-text reply: cut at the sign-off or the quoted-original line. */
function stripQuotedText(text: string): string {
    const markers = [
        /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
        /^\s*Von:\s.*$/m,
        /^\s*From:\s.*$/m,
        /^\s*Am .* schrieb .*:\s*$/m,
        /^\s*On .* wrote:\s*$/m,
        /^\s*--\s*$/m,
        /^\s*(Mit freundlichen Grüßen|Viele Grüße|Freundliche Grüße|Beste Grüße)\b/im,
        /^\s*(Best regards|Kind regards|Best wishes|Regards|Sincerely)\b/im,
        /^\s*(Pozdrawiam|Z poważaniem)\b/im,
    ];
    let cut = text.length;
    for (const m of markers) {
        const at = text.search(m);
        if (at > 20 && at < cut) cut = at;
    }
    return text.slice(0, cut).trim();
}

function safeHtml(mail: IncomingMail): string {
    if (!mail.isHtml) {
        const escaped = stripQuotedText(mail.body)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\r?\n/g, '<br>');
        return escaped.trim();
    }

    return sanitizeHtml(stripQuotedHtml(mail.body), {
        allowedTags: [
            'p', 'br', 'div', 'span', 'a', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup',
            'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'img',
        ],
        allowedAttributes: {
            a: ['href', 'title'],
            img: ['src', 'alt', 'width', 'height'],
            '*': ['style'],
        },
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedSchemesByTag: { img: ['http', 'https'] },
        /* A short allowlist of visual styles, so colours and alignment survive but a style value
           can't smuggle anything executable. */
        allowedStyles: {
            '*': {
                color: [/^[^;{}()]+$/],
                'background-color': [/^[^;{}()]+$/],
                'font-weight': [/^[\w-]+$/],
                'font-style': [/^[\w-]+$/],
                'text-align': [/^(left|right|center|justify)$/],
                'text-decoration': [/^[\w-\s]+$/],
            },
        },
        /* Every link opens in a new tab and is severed from this page. */
        transformTags: {
            a: (tagName, attribs) => ({
                tagName,
                attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
            }),
        },
    }).trim();
}

export type PollResult = { seen: number; filed: number; automated: number };

export async function pollOnce(): Promise<PollResult> {
    let seen = 0;
    let filed = 0;
    let automated = 0;

    for (const mail of await unreadMail()) {
        seen++;

        /* Match to one of our inquiries by either signal — either alone is enough, neither is
           required:
             1. Threading headers → In-Reply-To first (the direct parent), then each References id
                newest-first. Invisible and automatic, but only present on a reply.
             2. The [BSS-MX-<id>] subject tag → catches a customer who writes a fresh mail (no reply
                header) but keeps or quotes the tag. Verified against the database, because the
                subject is text a customer can edit.
           A mail matching neither is someone writing to the mailbox unprompted, and is left alone. */
        let inquiryId: string | null =
            mail.inReplyTo ? await inquiryByMessageId(mail.inReplyTo) : null;

        if (!inquiryId) {
            for (const ref of [...mail.references].reverse()) {
                inquiryId = await inquiryByMessageId(ref);
                if (inquiryId) break;
            }
        }

        if (!inquiryId) {
            const tagged = inquiryIdFromSubject(mail.subject);
            if (tagged && (await inquiryExists(tagged))) inquiryId = tagged;
        }

        if (!inquiryId) continue;

        /* A bounce or out-of-office reaches the reply address like a real reply — it goes to the
           history, not the thread, so the customer's words are not faked. Marked read either way,
           or the next run finds it again. */
        if (mail.automated) {
            await recordEvent(inquiryId, 'delivery', null, mail.subject || 'Automatic reply');
            await markRead(mail.graphId);
            automated++;
            continue;
        }

        const stored = await recordMessage({
            inquiryId,
            direction: 'in',
            from: mail.from,
            to: mail.recipients[0] ?? '',
            subject: mail.subject,
            body: safeHtml(mail),
            messageId: mail.messageId,
            inReplyTo: mail.inReplyTo,
            at: mail.receivedAt,
        });

        /* Marked read only once it is safely stored: if the insert throws, the mail stays unread
           and the next run picks it up rather than losing a customer reply. */
        await markRead(mail.graphId);
        if (stored) filed++;
    }

    return { seen, filed, automated };
}

/* Poll on demand, at most once per window. Called when the admin page loads (see page.tsx) instead
   of a background timer: replies are fetched when someone is actually looking at the desk, and the
   server never does idle work when no one is. The gap stops a burst of refreshes from hammering
   Graph — a second load inside the window just reuses what the first fetched. */
const POLL_MIN_GAP_MS = Number(process.env.MAIL_POLL_MIN_GAP_MS ?? 20_000);

export async function maybePoll(): Promise<void> {
    if (!mailConfigured()) return;
    const g = globalThis as unknown as { __lastMailPoll?: number };
    const now = Date.now();
    if (g.__lastMailPoll && now - g.__lastMailPoll < POLL_MIN_GAP_MS) return;
    g.__lastMailPoll = now;
    try {
        await pollOnce();
    } catch (err) {
        console.error('[mail poll] on-load poll failed:', err);
    }
}

/* Whether mail is configured at all — used to stay quiet when the mailbox is not set up yet,
   instead of logging an error on every page load. */
export function mailConfigured(): boolean {
    return Boolean(
        process.env.MS_TENANT_ID &&
            process.env.MS_CLIENT_ID &&
            process.env.MS_CLIENT_SECRET &&
            process.env.MAIL_MAILBOX,
    );
}
