-- BSS LogisQ — inquiry desk schema (PostgreSQL / Neon)
--
-- Two tables. An inquiry has no sub-parts worth normalising; the second table is its history, and
-- exists because a row edited in place cannot answer "who changed this, and from what".
--
-- Written to be run repeatedly: every statement is IF NOT EXISTS, so applying it to an existing
-- database is a no-op rather than an error. That is what lets the app run it on every start
-- without anyone deciding whether this is the first boot.
--
-- ── Notes for anyone who knew the MariaDB version of this file ──
-- * BIGSERIAL replaces BIGINT AUTO_INCREMENT.
-- * TIMESTAMPTZ replaces DATETIME. Postgres stores an instant and hands it back in UTC, so the
--   UTC-pinning the MariaDB driver needed is gone — there is nothing left to pin.
-- * updated_at has no ON UPDATE equivalent here. Rather than a plpgsql trigger, the three places
--   that write a row set `updated_at = now()` themselves (src/app/actions.ts). One line each, and
--   it keeps this file to plain statements that can be applied one at a time — which is what the
--   Neon HTTP driver can send.
-- * TEXT everywhere it was VARCHAR: Postgres indexes TEXT with no prefix length and stores it
--   identically, so the lengths are enforced by the ingest endpoint alone, where they already were.
-- * ILIKE replaces the utf8mb4_unicode_ci collation for case-insensitive search, and there is no
--   charset to declare: Neon databases are UTF-8.

CREATE TABLE IF NOT EXISTS inquiries (
    id              BIGSERIAL       PRIMARY KEY,

    -- ── What the visitor sent ──────────────────────────────────────────────
    -- Mirrors the website form exactly (src/app/api/contact/route.ts there).
    -- phone is optional on the form; everything else is validated as required
    -- before it reaches us.
    first_name      TEXT            NOT NULL,
    last_name       TEXT            NOT NULL,
    company         TEXT            NOT NULL,
    email           TEXT            NOT NULL,
    subject         TEXT            NOT NULL,
    message         TEXT            NOT NULL,
    phone           TEXT                NULL,

    -- ── Proof of consent (doc ARCH-DQ-WEB-001, rule 5) ─────────────────────
    -- Stored WITH the message rather than inferred later: if someone asks on what basis we hold
    -- a person's details, the answer has to be in the same row as the details.
    consent_given   BOOLEAN         NOT NULL DEFAULT TRUE,
    privacy_version TEXT                NULL,

    -- ── Where it came from ─────────────────────────────────────────────────
    -- locale tells sales which language to answer in. source_ip is kept only for abuse handling
    -- and is deliberately never shown in the UI.
    locale          TEXT                NULL,
    source_ip       TEXT                NULL,

    -- ── How the team works it ──────────────────────────────────────────────
    -- A CHECK rather than an enum type: adding a state to a Postgres enum is a migration, and
    -- this list will change as the team learns how it wants to work.
    status          TEXT            NOT NULL DEFAULT 'new',
    assignee        TEXT                NULL,
    notes           TEXT                NULL,

    received_at     TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),

    CONSTRAINT inquiries_status_chk
        CHECK (status IN ('new', 'in_progress', 'answered', 'closed', 'spam'))
);

-- Keep the status CHECK in step with the app's status list on a database that already exists.
-- CREATE TABLE above is IF NOT EXISTS, so on an existing table it is a no-op and would never widen
-- the constraint — a status added later (e.g. 'closed') would be rejected until someone ran a
-- migration by hand. Re-applying it here on every boot removes that step: drop the old constraint
-- if present, add the current one. Existing rows already hold a subset of these values, so the add
-- validates instantly.
ALTER TABLE inquiries DROP CONSTRAINT IF EXISTS inquiries_status_chk;
ALTER TABLE inquiries ADD  CONSTRAINT inquiries_status_chk
    CHECK (status IN ('new', 'in_progress', 'answered', 'closed', 'spam'));

-- The list is always newest-first and usually filtered by status, so these two earn their keep.
-- email and company are indexed because they are what someone searches by when they are looking
-- for one specific inquiry rather than browsing.
CREATE INDEX IF NOT EXISTS inquiries_received_at_idx ON inquiries (received_at DESC);
CREATE INDEX IF NOT EXISTS inquiries_status_idx      ON inquiries (status);
CREATE INDEX IF NOT EXISTS inquiries_email_idx       ON inquiries (email);
CREATE INDEX IF NOT EXISTS inquiries_company_idx     ON inquiries (company);

-- ── History ────────────────────────────────────────────────────────────────
-- Every change the team makes on the desk is written here as well as to the row. The row says
-- what an inquiry is now; this says what it was and who changed it. Without it, "was this ever
-- marked answered, and by whom?" has no answer — the previous value is simply gone.
--
-- Deleting an inquiry takes its history with it: the history exists to explain a record, and
-- outliving that record would leave personal data behind after an erasure request.
CREATE TABLE IF NOT EXISTS inquiry_events (
    id              BIGSERIAL       PRIMARY KEY,
    inquiry_id      BIGINT          NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    at              TIMESTAMPTZ     NOT NULL DEFAULT now(),

    -- Who made the change. With the desk reachable only from inside the network and no login in
    -- front of it, this is the address it came from rather than a name. When a sign-in is added
    -- the account goes here instead, and rows written before that stay readable.
    actor           TEXT                NULL,

    -- 'status', 'assignee' or 'notes' — which field moved.
    field           TEXT            NOT NULL,
    from_value      TEXT                NULL,
    to_value        TEXT                NULL
);

CREATE INDEX IF NOT EXISTS inquiry_events_inquiry_idx ON inquiry_events (inquiry_id, at DESC);

-- ── The conversation ───────────────────────────────────────────────────────
-- Every mail sent from the desk, and every reply that came back. One row per message, oldest
-- readable as a thread by ordering on at.
--
-- Replies find their way to the right inquiry because each outgoing mail carries a reply address
-- of its own — inquiries+<id>.<token>@domain — so matching is exact rather than guessed from the
-- sender's address. message_id and in_reply_to are stored as the fallback for mail clients that
-- strip the plus part, and as the thing that makes a delivered mail traceable afterwards.
CREATE TABLE IF NOT EXISTS inquiry_messages (
    id              BIGSERIAL       PRIMARY KEY,
    inquiry_id      BIGINT          NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    at              TIMESTAMPTZ     NOT NULL DEFAULT now(),

    -- 'out' = we wrote to the customer, 'in' = the customer wrote back.
    direction       TEXT            NOT NULL,

    -- Who sent it, as it appeared on the mail. For an outgoing message this is the shared
    -- mailbox; `actor` is the person at the desk who pressed Send.
    from_addr       TEXT            NOT NULL,
    to_addr         TEXT            NOT NULL,
    actor           TEXT                NULL,

    subject         TEXT            NOT NULL,
    body            TEXT            NOT NULL,

    -- RFC 5322 identifiers. message_id is unique so a reply seen twice — the poller running
    -- while the last one had not finished, a mailbox restored from backup — is stored once and
    -- not duplicated into the thread.
    message_id      TEXT                NULL,
    in_reply_to     TEXT                NULL,

    CONSTRAINT inquiry_messages_direction_chk CHECK (direction IN ('out', 'in'))
);

CREATE INDEX IF NOT EXISTS inquiry_messages_inquiry_idx ON inquiry_messages (inquiry_id, at);
CREATE UNIQUE INDEX IF NOT EXISTS inquiry_messages_message_id_idx ON inquiry_messages (message_id) WHERE message_id IS NOT NULL;
