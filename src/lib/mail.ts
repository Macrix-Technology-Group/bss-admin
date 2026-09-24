import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* Sending from the desk, and finding the replies that come back.
 *
 * Both halves go through Microsoft Graph against one shared mailbox. SMTP would do the sending,
 * but Microsoft has turned off basic authentication for SMTP and IMAP, so an SMTP route needs
 * OAuth anyway — and then it is two mechanisms and two sets of credentials for one mailbox.
 * Graph does both with the app registration that reading already requires.
 *
 * The app registration must be limited to this ONE mailbox with an Exchange application access
 * policy. Mail.Send and Mail.ReadWrite as application permissions are tenant-wide by default:
 * without that policy, the desk can read and send as every mailbox in the company. See README.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';

function env(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set — see .env.example`);
    return value;
}

/* ── The reply address ─────────────────────────────────────────────────────
   The desk sends from, and asks for replies at, the one plain shared address: contact@domain.
   Nothing is added to it — no per-inquiry tag.

   A reply is matched back to its inquiry from the mail's own threading headers instead: every mail
   the desk sends has a Message-ID, which is stored, and when the customer hits Reply their client
   quotes that ID in the In-Reply-To (and References) header. The poller reads the ID back out and
   finds the inquiry it belongs to. See mailPoll. (A brand-new mail to contact@ that is not a reply
   carries no such header, so it stays "someone writing to the mailbox" — the same limit the tagged
   address had.) */
function replyAddress(): string {
    return env('MAIL_REPLY_ADDRESS');
}

/* ── The subject tag ───────────────────────────────────────────────────────
   A visible reference the desk adds to every outgoing subject: "… [BSS-MX-1042]". It is the second
   way a reply is matched, and the only one that survives when the customer does NOT reply but
   instead writes a fresh mail and keeps (or types) the tag — a case the hidden Message-ID header
   cannot cover, because a new mail carries no In-Reply-To. Either signal is enough on its own;
   neither is required. */
function subjectTag(inquiryId: string): string {
    return `[BSS-MX-${inquiryId}]`;
}

/* Adds the tag to a subject unless it already carries one for this inquiry (a reply keeps the
   quoted "Re: … [BSS-MX-1042]", so it must not be appended twice). */
function ensureSubjectTag(subject: string, inquiryId: string): string {
    return inquiryIdFromSubject(subject) === inquiryId
        ? subject
        : `${subject} ${subjectTag(inquiryId)}`;
}

/* Reads the inquiry id back out of a subject, or null if there is no tag. The value is verified
   against the database by the caller before anything is filed, since a subject is text a customer
   can edit. */
export function inquiryIdFromSubject(subject: string): string | null {
    return /\[BSS-MX-(\d+)\]/i.exec(subject)?.[1] ?? null;
}

/* ── Talking to Graph ──────────────────────────────────────────────────────
   Client-credentials token, cached until shortly before it expires. One token serves every
   request this process makes; asking for a new one per message would be a second round trip on
   every send for nothing. */
let token: { value: string; expiresAt: number } | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* fetch with a per-attempt timeout and a couple of retries. Microsoft's endpoints occasionally
   refuse the first connection — a cold socket that exceeds the default connect timeout, or a
   transient 5xx/429 — which showed up as "the first Send fails, the second works". Retrying inside
   the call turns that into a single Send that just works. Each attempt gets its own AbortSignal so
   a hung connection fails fast rather than waiting out the default timeout. */
async function fetchRetry(url: string, init: RequestInit = {}, tries = 3): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < tries; attempt++) {
        try {
            const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
            /* Transient server-side conditions are worth another go; anything else (including a
               4xx like the access-policy 403) is a real answer and returned as-is. */
            if (res.status >= 500 || res.status === 429) {
                lastErr = new Error(`HTTP ${res.status}`);
            } else {
                return res;
            }
        } catch (err) {
            lastErr = err;
        }
        if (attempt < tries - 1) await sleep(400 * (attempt + 1));
    }
    throw lastErr;
}

async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;

    const res = await fetchRetry(
        `https://login.microsoftonline.com/${env('MS_TENANT_ID')}/oauth2/v2.0/token`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: env('MS_CLIENT_ID'),
                client_secret: env('MS_CLIENT_SECRET'),
                scope: 'https://graph.microsoft.com/.default',
                grant_type: 'client_credentials',
            }),
        },
    );

    if (!res.ok) throw new Error(`Microsoft refused the token: ${res.status} ${await res.text()}`);

    const body = (await res.json()) as { access_token: string; expires_in: number };

    /* A minute of slack, so a token that is about to lapse is not used for a request that then
       fails halfway through a send. */
    token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return token.value;
}

async function graph(path: string, init: RequestInit = {}) {
    const res = await fetchRetry(`${GRAPH}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${await accessToken()}`,
            'Content-Type': 'application/json',
            ...init.headers,
        },
    });

    if (!res.ok) {
        /* Graph puts the real reason in the body; the status alone is rarely enough to act on. */
        throw new Error(`Graph ${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
    }

    return res.status === 202 ? null : res.json();
}

/* Escapes the reply text so it is shown, never interpreted, when placed into the HTML body — the
   text is what a person typed and must not become markup. */
function esc(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/* The logo, read from public/bss-logisq-email.png once at startup and turned into a data: URI so
   the image travels inside the email itself — no hosted URL, no blob (a blob: URL only lives in the
   sender's browser session and shows as a broken box in received mail). To change the logo, replace
   that PNG file; nothing here needs editing. Read is wrapped so a missing file leaves the URI empty
   and the signature still sends, just without the image. */
const LOGO_DATA_URI: string = (() => {
    try {
        const buf = readFileSync(join(process.cwd(), 'public', 'bss-logisq-email.png'));
        return `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
        return '';
    }
})();

/* The company signature block, matching the house style. The signer's name is the person the
   inquiry is assigned to, or "Sales Team" when it is unassigned. Per-person title, phone and
   direct email are not something the desk holds, so the block uses the shared contact address and
   the company details, which are the same for everyone. Inline styles only — email clients strip
   <style> blocks and classes. */
function signatureHtml(signerName: string): string {
    const blue = '#2d8fc7';
    return (
        `<div style="margin-top:22px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1a1a1a;line-height:1.5;">`
        + `<p style="margin:0 0 12px;">Pozdrawiam / Mit freundlichen Grüßen / Best Regards</p>`
        + `<p style="margin:0;"><strong style="font-size:14px;">${esc(signerName)}</strong><br>`
        + `BSS LogisQ<br>`
        + `<a href="mailto:contact@bss-logisq.com" style="color:${blue};text-decoration:none;">contact@bss-logisq.com</a></p>`
        + `<p style="margin:12px 0 0;"><strong>BSS LogisQ Sp. z o. o.</strong><br>`
        + `ul. Marcelińska 90,<br>60-324 Poznań, Poland<br>`
        + `<a href="https://www.bss-logisq.com" style="color:${blue};text-decoration:none;">www.bss-logisq.com</a></p>`
        + (LOGO_DATA_URI
            ? `<div style="margin:14px 0 10px;">`
              + `<img src="${LOGO_DATA_URI}" `
              + `alt="BSS LogisQ" width="180" style="width:180px;height:auto;display:block;border:0;" /></div>`
            : '')
        + `<p style="margin:0;padding-top:10px;border-top:1px solid #e3e8ef;font-size:10px;color:#9aa4b0;line-height:1.5;">`
        + `Note: The information contained in this message may be privileged and confidential and protected from disclosure. `
        + `Any dissemination, distribution or copying of this communication is strictly prohibited. If you received this in error, `
        + `please contact the sender and delete the material from any computer. Thank you.</p>`
        + `</div>`
    );
}

/* ── Sending ───────────────────────────────────────────────────────────────
   Graph's sendMail does not hand back the Message-ID it assigned, and the thread needs one to
   match a reply against. So the message is created as a draft, which returns its id and
   internetMessageId, and then sent. Two calls instead of one, in exchange for a reply that can
   always be traced to what it answered.

   Sent as HTML so the signature carries the house style. The reply text the person typed is
   escaped and its line breaks preserved; the signature is appended after it. The same HTML is
   returned so the thread can store and show exactly what went out, signature and all. It is safe
   to render because every part of it is built here — the person's text is escaped, the rest is
   our own markup — never customer-supplied HTML. */
export async function sendMail(opts: {
    inquiryId: string;
    to: string;
    subject: string;
    body: string;
    signerName?: string;
}): Promise<{ messageId: string; from: string; html: string }> {
    const mailbox = env('MAIL_MAILBOX');

    const html =
        `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;">`
        + esc(opts.body).replace(/\r?\n/g, '<br>')
        + `</div>`
        + signatureHtml(opts.signerName?.trim() || 'Sales Team');

    const draft = (await graph(`/users/${mailbox}/messages`, {
        method: 'POST',
        body: JSON.stringify({
            subject: ensureSubjectTag(opts.subject, opts.inquiryId),
            body: { contentType: 'HTML', content: html },
            toRecipients: [{ emailAddress: { address: opts.to } }],
            replyTo: [{ emailAddress: { address: replyAddress() } }],
        }),
    })) as { id: string; internetMessageId: string };

    await graph(`/users/${mailbox}/messages/${draft.id}/send`, { method: 'POST' });

    return { messageId: draft.internetMessageId, from: mailbox, html };
}

/* ── Reading ───────────────────────────────────────────────────────────────
   Unread mail in the inbox, newest last. Only what is needed to file it: the poller decides
   which of these belong to an inquiry and leaves the rest alone. */
export type IncomingMail = {
    graphId: string;
    messageId: string;
    /* The parent this is a reply to (In-Reply-To), and the fuller chain of every message it
       descends from (References). Either can carry one of our sent Message-IDs, which is how the
       reply is matched to its inquiry. */
    inReplyTo: string | null;
    references: string[];
    from: string;
    recipients: string[];
    subject: string;
    /* The body as it arrived, and whether it is HTML. The poller sanitizes it before storing — the
       whole message is kept, only executable bits (scripts, event handlers) are removed. */
    body: string;
    isHtml: boolean;
    receivedAt: string;
    /* True for a bounce, an out-of-office, or anything else a machine sent. These arrive at the
       reply address exactly like a real reply and would otherwise be filed as one — a delivery
       failure appearing in the thread as "Anna replied", with an Office 365 logo for a body. */
    automated: boolean;
};

/* Two tests, because either alone misses cases.

   The header is the standard one (RFC 3834): Exchange sets Auto-Submitted on bounces and on
   out-of-office replies, and anything other than "no" means no human pressed send.

   The addresses are the ones that send delivery reports without always setting that header —
   Exchange's own system mailbox is a long hex string nobody would guess, so it is matched on its
   shape rather than in full. */
function looksAutomated(m: GraphMessage, from: string): boolean {
    const header = m.internetMessageHeaders
        ?.find((h) => h.name.toLowerCase() === 'auto-submitted')?.value;

    if (header && header.trim().toLowerCase() !== 'no') return true;

    const local = from.split('@')[0]?.toLowerCase() ?? '';
    return (
        local.startsWith('microsoftexchange')
        || local === 'postmaster'
        || local === 'mailer-daemon'
        || local === 'no-reply'
        || local === 'noreply'
    );
}

export async function unreadMail(limit = 50): Promise<IncomingMail[]> {
    const mailbox = env('MAIL_MAILBOX');

    /* HTML, not text: the customer's message is kept as they wrote it — formatting, links and
       signature — and sanitized before it is stored. (Earlier this asked Exchange for a text
       conversion; now the full message is shown, so we take the HTML.) */
    const res = (await graph(
        `/users/${mailbox}/mailFolders/inbox/messages`
        + `?$filter=isRead eq false&$top=${limit}&$orderby=receivedDateTime asc`
        + `&$select=id,internetMessageId,internetMessageHeaders,from,toRecipients,ccRecipients,subject,body,bodyPreview,receivedDateTime`,
    )) as { value: Record<string, never>[] };

    return (res.value as unknown as GraphMessage[]).map((m) => {
        const from = m.from?.emailAddress?.address ?? '';
        const isHtml = (m.body?.contentType ?? '').toLowerCase() === 'html';
        return {
        graphId: m.id,
        messageId: m.internetMessageId,
        inReplyTo:
            m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === 'in-reply-to')?.value
            ?? null,
        /* References is a space-separated list of <Message-ID>s, oldest first. Split into the
           individual bracketed ids so each can be looked up. */
        references:
            m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === 'references')?.value
                ?.match(/<[^>]+>/g) ?? [],
        from,
        automated: looksAutomated(m, from),
        /* Cc as well as To: someone who replies-all to a mail whose Reply-To is our address can
           easily leave that address in Cc rather than To. */
        recipients: [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])]
            .map((r) => r.emailAddress.address),
        subject: m.subject ?? '',
        body: m.body?.content ?? m.bodyPreview ?? '',
        isHtml,
        receivedAt: m.receivedDateTime,
        };
    });
}

/* Enough HTML-to-text to rescue a mail Exchange did not convert. Not a parser and not trying to
   be: style and script contents are dropped outright because rendering them as text is worse than
   losing them, block tags become line breaks, everything else is stripped and the handful of
   entities that actually appear in mail are decoded. */
function asText(content: string, contentType?: string): string {
    if (contentType?.toLowerCase() !== 'html' && !/^\s*<(!doctype|html)\b/i.test(content)) {
        return content.trim();
    }

    return content
        .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        /* Three or more blank lines is what a stripped signature table leaves behind. */
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

type GraphMessage = {
    id: string;
    internetMessageId: string;
    internetMessageHeaders?: { name: string; value: string }[];
    from?: { emailAddress?: { address?: string } };
    toRecipients?: { emailAddress: { address: string } }[];
    ccRecipients?: { emailAddress: { address: string } }[];
    subject?: string;
    body?: { contentType: string; content: string };
    bodyPreview?: string;
    receivedDateTime: string;
};

/* Marked read rather than deleted or moved. The mailbox stays the company's record of its own
   mail — the desk takes a copy and says "I have seen this", and a human can still find the
   original where they expect it. It is also what stops the next poll re-filing the same reply. */
export async function markRead(graphId: string): Promise<void> {
    await graph(`/users/${env('MAIL_MAILBOX')}/messages/${graphId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isRead: true }),
    });
}
