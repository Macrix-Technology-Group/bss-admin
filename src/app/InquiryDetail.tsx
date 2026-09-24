'use client';

import { useState, useTransition } from 'react';
import { setStatus, setAssignee, setNotes, sendReply } from './actions';
import {
    STATUSES,
    TEAM,
    type Inquiry,
    type InquiryEvent,
    type InquiryMessage,
} from '@/lib/inquiry';

const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]));

/* What one history entry says, in a sentence someone in sales would write.
 *
 * Notes are summarised rather than quoted: a note can be five hundred words, and the history is
 * a margin note about the record, not a second copy of it. The status and the handler are short
 * enough to show in full, and those are the two anyone actually asks about. */
function describe(event: InquiryEvent): string {
    if (event.field === 'status') {
        const from = STATUS_LABEL[event.from_value ?? ''] ?? event.from_value ?? 'nothing';
        const to = STATUS_LABEL[event.to_value ?? ''] ?? event.to_value;
        return `Status: ${from} → ${to}`;
    }
    if (event.field === 'assignee') {
        return event.to_value
            ? `Handed to ${event.to_value}${event.from_value ? ` (was ${event.from_value})` : ''}`
            : `Unassigned${event.from_value ? ` (was ${event.from_value})` : ''}`;
    }
    if (event.field === 'notes') {
        if (!event.to_value) return 'Note cleared';
        return event.from_value ? 'Note edited' : 'Note added';
    }
    /* Written by the mail poller, not by anyone at the desk: a bounce or an out-of-office that
       came back to our reply address. In the history rather than the thread, because it is not
       something the customer wrote. */
    if (event.field === 'delivery') {
        return `Automatic reply from the mail server: ${event.to_value}`;
    }
    return event.field;
}

/* The actor is only worth showing when it is a person's name. With no sign-in yet it is the
   network address a change came from (::1 in dev, a VPN IP in production) — meaningless to read,
   so those are hidden. Kept in the database regardless, for audit; this only governs display. When
   a sign-in is added the account name will pass this test and show. */
function displayActor(actor: string | null): string | null {
    if (!actor) return null;
    const a = actor.trim();
    if (a === '' || a.toLowerCase() === 'unknown') return null;
    /* Only IP characters (digits, dots, colons, hex) → an address, not a name. */
    if (/^[0-9a-f:.]+$/i.test(a)) return null;
    return a;
}

/* A small icon and a tone (which tints the dot) per kind of change, so the timeline can be read
   by shape and colour before the words. */
function eventVisual(field: string): { tone: string; icon: React.ReactNode } {
    const path = (d: string) => (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {d.split('|').map((p, i) => <path key={i} d={p} />)}
        </svg>
    );
    switch (field) {
        case 'status':
            return { tone: 'status', icon: path('M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z|M4 22v-7') };
        case 'assignee':
            return { tone: 'assignee', icon: path('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2|M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z') };
        case 'notes':
            return { tone: 'notes', icon: path('M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7|M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z') };
        case 'delivery':
            return { tone: 'delivery', icon: path('M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z|M12 9v4|M12 17h.01') };
        default:
            return { tone: '', icon: path('M12 12h.01') };
    }
}

/* The panel an inquiry opens into.
 *
 * Split out of the old InquiryRow when the table moved to TanStack: the row is now rendered from a
 * column definition, so the only part left that owns its own state is this. */
export default function InquiryDetail({
    q,
    history = [],
    thread = [],
    onDone,
}: {
    q: Inquiry;
    history?: InquiryEvent[];
    thread?: InquiryMessage[];
    onDone: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const received = new Date(q.received_at);

    /* The three fields are held here and written only when Save is pressed.

       They used to save on change and on blur, which meant a mis-click on the status list was a
       write nobody asked for and could not take back. Keeping the edit local makes Cancel possible
       and makes one Save cover all three fields instead of three separate writes. */
    const [status, setStatusValue] = useState(q.status as string);
    const [assignee, setAssigneeValue] = useState(q.assignee ?? '');
    const [notes, setNotesValue] = useState(q.notes ?? '');

    /* The left column switches between the conversation and the change history — one at a time,
       so neither pushes the other down the panel. Opens on Messages. */
    const [tab, setTab] = useState<'messages' | 'history'>('messages');

    /* The reply box is separate from the three fields above and saves on its own. Sending a mail
       is not an edit that can be cancelled, so folding it into Save — which is undoable right up
       until it is pressed — would put an irreversible action behind a button that promises the
       opposite.

       The subject defaults to the customer's own, prefixed, so their client threads our reply
       with what they sent. */
    const [replyOpen, setReplyOpen] = useState(false);
    const [replySubject, setReplySubject] = useState(
        q.subject.toLowerCase().startsWith('re:') ? q.subject : `Re: ${q.subject}`,
    );
    const [replyBody, setReplyBody] = useState('');
    const [replyError, setReplyError] = useState<string | null>(null);
    const [sending, startSending] = useTransition();

    const send = () =>
        startSending(async () => {
            setReplyError(null);
            const result = await sendReply(q.id, replySubject, replyBody);
            if (result.ok) {
                setReplyBody('');
                setReplyOpen(false);
            } else {
                setReplyError(result.error ?? 'The mail could not be sent.');
            }
        });

    const dirty =
        status !== q.status || assignee !== (q.assignee ?? '') || notes !== (q.notes ?? '');

    /* Both buttons close the panel afterwards — the work queue is the list, so finishing with an
       inquiry should put you back in it rather than leaving a panel open over the next rows. */
    const cancel = () => {
        setStatusValue(q.status);
        setAssigneeValue(q.assignee ?? '');
        setNotesValue(q.notes ?? '');
        onDone();
    };

    const save = () =>
        startTransition(async () => {
            /* Only what actually changed. Sequential rather than parallel: they are three UPDATEs
               against one row, and a pool of five shared with everyone else on the screen is not
               worth spending three connections on to save a few milliseconds. */
            if (status !== q.status) await setStatus(q.id, status);
            if (assignee !== (q.assignee ?? '')) await setAssignee(q.id, assignee);
            if (notes !== (q.notes ?? '')) await setNotes(q.id, notes);
            /* Closed only once the writes have returned, so the row underneath is already showing
               the new status and handler when it reappears. */
            onDone();
        });

    return (
        <div className="detail-inner">
            <div>
                {/* One panel that switches between the conversation and the change history. The
                    tabs float in the top-right of the box — always free, since the first message
                    (the inquiry) is incoming and sits on the left. Icon + count only, no labels. */}
                <div className="switchWrap">
                    <div className="switchTabs">
                        <button
                            type="button"
                            className="switchTab"
                            data-on={tab === 'messages'}
                            onClick={() => setTab('messages')}
                            title="Messages"
                            aria-label={`Messages (${thread.length + 1})`}
                        >
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                                strokeLinejoin="round" aria-hidden="true">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                            </svg>
                            {/* +1 for the original inquiry, the first message in the thread. */}
                            <span className="switchCount">{thread.length + 1}</span>
                        </button>
                        <button
                            type="button"
                            className="switchTab"
                            data-on={tab === 'history'}
                            onClick={() => setTab('history')}
                            title="History"
                            aria-label={`History (${history.length})`}
                        >
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                                strokeLinejoin="round" aria-hidden="true">
                                <path d="M12 8v4l3 2" /><path d="M3.05 11a9 9 0 1 1 .5 4" /><path d="M3 4v4h4" />
                            </svg>
                            <span className="switchCount">{history.length}</span>
                        </button>
                    </div>

                    <div className="switchBody">
                    {tab === 'messages' ? (
                        /* A chat thread. The original inquiry from the contact form is the first
                           message — an incoming bubble on the left — then everything sent and
                           received since, in order. No name labels, just the bubble and its time. */
                        <ol className="thread">
                            <li data-direction="in">
                                <div className="bubble">
                                    <pre className="message">{q.message}</pre>
                                    <time className="bubbleTime">
                                        {received.toLocaleString('de-DE', {
                                            day: '2-digit', month: '2-digit',
                                            hour: '2-digit', minute: '2-digit',
                                        })}
                                    </time>
                                </div>
                            </li>
                            {thread.map((m) => (
                                <li key={m.id} data-direction={m.direction}>
                                    <div className="bubble">
                                        {/* Incoming replies are the customer's own message, stored
                                            as HTML the poller has already sanitized (safe to
                                            render). What we sent stays plain typed text. */}
                                        {m.direction === 'in' ? (
                                            <div
                                                className="message msgHtml"
                                                dangerouslySetInnerHTML={{ __html: m.body }}
                                            />
                                        ) : (
                                            <pre className="message">{m.body}</pre>
                                        )}
                                        <time className="bubbleTime">
                                            {new Date(m.at).toLocaleString('de-DE', {
                                                day: '2-digit', month: '2-digit',
                                                hour: '2-digit', minute: '2-digit',
                                            })}
                                        </time>
                                    </div>
                                </li>
                            ))}
                        </ol>
                    ) : history.length === 0 ? (
                        <p className="muted switchEmpty">Nothing has been changed since this arrived.</p>
                    ) : (
                        <ol className="timeline">
                            {history.map((event) => {
                                const v = eventVisual(event.field);
                                return (
                                    <li key={event.id} className="tlItem">
                                        <span className="tlDot" data-tone={v.tone} aria-hidden="true">
                                            {v.icon}
                                        </span>
                                        <div className="tlBody">
                                            <div className="tlAction">{describe(event)}</div>
                                            <div className="tlMeta">
                                                <time>
                                                    {new Date(event.at).toLocaleString('de-DE', {
                                                        day: '2-digit', month: 'short', year: 'numeric',
                                                        hour: '2-digit', minute: '2-digit',
                                                    })}
                                                </time>
                                                {displayActor(event.actor) && (
                                                    <>
                                                        <span className="tlSep">·</span>
                                                        <span>{displayActor(event.actor)}</span>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                    </div>
                </div>

                {/* The reply form, opened by the button pinned at the bottom of this column. When
                    open it appears here, below the conversation it belongs to. */}
                {replyOpen && (
                    <div className="reply">
                        <div className="field">
                            <label htmlFor={`subject-${q.id}`}>Subject</label>
                            <input
                                id={`subject-${q.id}`}
                                value={replySubject}
                                disabled={sending}
                                onChange={(e) => setReplySubject(e.target.value)}
                            />
                        </div>

                        <div className="field">
                            <label htmlFor={`reply-${q.id}`}>To {q.email}</label>
                            <textarea
                                id={`reply-${q.id}`}
                                rows={6}
                                value={replyBody}
                                disabled={sending}
                                placeholder="Their reply comes back here, not to your own inbox."
                                onChange={(e) => setReplyBody(e.target.value)}
                            />
                        </div>
                    </div>
                )}

                {/* Action row pinned to the bottom of the column (margin-top:auto), so it sits on
                    the same level as Save/Cancel on the right. */}
                <div className="colActions">
                    {replyOpen ? (
                        <>
                            <button
                                type="button"
                                className="btn"
                                disabled={sending || !replyBody.trim()}
                                onClick={send}
                            >
                                {sending ? 'Sending…' : 'Send'}
                            </button>
                            <button
                                type="button"
                                className="btn ghost"
                                disabled={sending}
                                onClick={() => {
                                    setReplyOpen(false);
                                    setReplyError(null);
                                }}
                            >
                                Cancel
                            </button>
                            {replyError && <span className="sendError">{replyError}</span>}
                        </>
                    ) : (
                        <button type="button" className="btn" onClick={() => setReplyOpen(true)}>
                            Reply by email
                        </button>
                    )}
                </div>
            </div>

            <div>
                <div className="field">
                    <label htmlFor={`status-${q.id}`}>Status</label>
                    <select
                        id={`status-${q.id}`}
                        value={status}
                        disabled={pending}
                        onChange={(e) => setStatusValue(e.target.value)}
                    >
                        {STATUSES.map((s) => (
                            <option key={s.value} value={s.value}>
                                {s.label}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="field">
                    <label htmlFor={`assignee-${q.id}`}>Handled by</label>
                    <select
                        id={`assignee-${q.id}`}
                        value={assignee}
                        disabled={pending}
                        onChange={(e) => setAssigneeValue(e.target.value)}
                    >
                        <option value="">Unassigned</option>
                        {TEAM.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                        {/* Someone who has left the team still appears on the inquiries they
                            handled. Without this the select would find no matching option, fall
                            back to the first one, and silently reassign the record on open. */}
                        {q.assignee && !TEAM.includes(q.assignee) && (
                            <option value={q.assignee}>{q.assignee} (no longer in the team)</option>
                        )}
                    </select>
                </div>

                <div className="field">
                    <label htmlFor={`notes-${q.id}`}>Internal notes</label>
                    <textarea
                        id={`notes-${q.id}`}
                        value={notes}
                        placeholder="Not visible to the customer"
                        disabled={pending}
                        onChange={(e) => setNotesValue(e.target.value)}
                    />
                </div>

                <div className="colActions">
                    {/* Save is disabled until something changes — a Save that writes nothing only
                        invites the question of what it did. Cancel stays enabled throughout,
                        because it now also closes the panel: with nothing edited it is simply the
                        way out. */}
                    <button type="button" className="btn" disabled={!dirty || pending} onClick={save}>
                        {pending ? 'Saving…' : 'Save'}
                    </button>
                    <button type="button" className="btn ghost" disabled={pending} onClick={cancel}>
                        Cancel
                    </button>
                    {dirty && !pending && <span className="muted">Unsaved changes</span>}
                </div>
            </div>

            {/* The provenance line — when it arrived, in what language, and the consent it was
                given under — full-width at the very bottom, styled as a quiet pale strip so it is
                there for the record ("on what basis do we hold this?", rule 5 of ARCH-DQ-WEB-001)
                without competing with the working controls. */}
            <div className="detailFoot">
                <span className="dfItem">
                    <span className="dfLabel">Received</span>
                    {received.toLocaleString('de-DE')}
                </span>
                {q.locale && (
                    <span className="dfItem">
                        <span className="dfLabel">Language</span>
                        {q.locale.toUpperCase()}
                    </span>
                )}
                <span className="dfItem">
                    <span className="dfLabel">Consent</span>
                    {q.consent_given ? 'given' : 'NOT RECORDED'}
                    {q.privacy_version && ` · privacy ${q.privacy_version}`}
                </span>
            </div>
        </div>
    );
}
