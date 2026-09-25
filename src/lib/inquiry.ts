/* Shape and vocabulary of an inquiry — and nothing else.
 *
 * Deliberately separate from db.ts. The row component is a client component and needs the type
 * and the status labels; if it imported them from db.ts it would pull `pg` with them, and the
 * bundler would try to resolve `dns`, `fs` and `net` for the browser. That is not a warning, it
 * is a failed build.
 *
 * Rule of thumb for this app: anything a client component imports lives here; anything that
 * opens a socket lives in db.ts.
 */

export type InquiryStatus = 'new' | 'in_progress' | 'answered' | 'closed' | 'spam';

export interface Inquiry {
    id: string;
    first_name: string;
    last_name: string;
    company: string;
    email: string;
    subject: string;
    message: string;
    phone: string | null;
    consent_given: boolean;
    privacy_version: string | null;
    locale: string | null;
    status: InquiryStatus;
    assignee: string | null;
    notes: string | null;
    received_at: string;
    updated_at: string;
}

/* One change somebody made on the desk. Lives here rather than in db.ts for the reason at the
   top of this file: the detail panel is a client component and needs this shape, and importing
   it from db.ts would drag the database driver into the browser bundle. */
export interface InquiryEvent {
    id: string;
    inquiry_id: string;
    at: string;
    actor: string | null;
    field: 'status' | 'assignee' | 'notes' | string;
    from_value: string | null;
    to_value: string | null;
}

export const STATUSES: { value: InquiryStatus; label: string }[] = [
    { value: 'new', label: 'New' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'answered', label: 'Answered' },
    /* Two end states outside the New→In progress→Answered pipeline: 'closed' is a finished inquiry
       (no further action), 'spam' is junk. Adding 'closed' needs the status CHECK in db/schema.sql
       to allow it — that file re-applies the constraint on every boot, so a deploy migrates the
       live database with no hand-run step. */
    { value: 'closed', label: 'Closed' },
    { value: 'spam', label: 'Spam' },
];

/* The people an inquiry can be assigned to — the team as listed on bss-logisq.com/company.
 *
 * Held here rather than read from the website: they are separate applications with separate
 * deployments, and a dropdown that changed silently because a marketing page was edited would be
 * worse than one that needs a line changing here. Update it when the team page changes.
 *
 * Stored by name, exactly as the website spells it. Taking someone off this list does not erase
 * them from inquiries they already handled — see the assignee control in InquiryDetail. */
/* Sorted here rather than written in order, so a name added to the end of the list still appears
   in the right place. localeCompare, not a plain <, because the plain comparison sorts by
   codepoint and would put Gräb after Gzzz. */
export const TEAM: string[] = [
    'Vasilios Dossis',
    'Martin Gräb',
    'Marcin Krzywulski',
    'Marek Zuchowski',
    'Józef Eckert',
    'Kamil Wilkosz',
    'Karl Tetz',
].sort((a, b) => a.localeCompare(b, 'de'));

/* One mail in an inquiry's conversation — sent from the desk, or a reply that came back.
   Here rather than in db.ts for the reason at the top of this file: the thread is rendered by a
   client component. */
export interface InquiryMessage {
    id: string;
    inquiry_id: string;
    at: string;
    direction: 'out' | 'in';
    from_addr: string;
    to_addr: string;
    actor: string | null;
    subject: string;
    body: string;
}
