# BSS LogisQ — Inquiry Desk

Internal application for reading and working the messages sent through the contact form on
bss-logisq.com. It runs on the Macrix network, separately from the public website.

Implements **Option 2** of `ARCH-DQ-WEB-001` ("Where Should Contact Form Messages Be Stored"),
deployed as its own application with its own schema on the company's MariaDB server.

---

## Read this first — there is no login

The screen has no authentication. That was a deliberate decision, and it is only safe under one
condition:

> **This application must never be reachable from the public internet.**

Anyone who can open the URL can read every customer's name, email address, phone number and
message, and nothing records who looked. The protection is the network, not the app.

Two things enforce that, and both must stay as they are:

1. `docker-compose.yml` publishes the app on `127.0.0.1:3100`, not `0.0.0.0`. It is reachable from
   the server itself and nowhere else.
2. Whatever reverse proxy is put in front of it must be restricted to the internal network.

If the app ever needs to be reachable from outside, **add a login first**. The code is structured
so that is a single middleware file plus a session check — it does not need a rewrite.

The one thing that *is* authenticated is `POST /api/inquiries`, the endpoint the website posts to.
That needs a shared token whatever happens, because an open write endpoint lets anyone fill the
team's desk with fabricated inquiries.

---

## Running it

```bash
cp .env.example .env
# fill in DB_USER, DB_PASSWORD and INGEST_TOKEN
#   openssl rand -hex 32       # INGEST_TOKEN — generate it, do not invent one
# QUOTE the password. '#' starts a comment in a .env file, so an unquoted secret
# containing one is silently truncated and you get "Access denied" with a
# password that looks perfectly correct in the file.

docker compose up -d --build
```

The app is then on `http://127.0.0.1:3100` on that server. The database schema is applied
automatically on every start; running it again on an existing database changes nothing.

```bash
docker compose logs -f app     # follow
docker compose down            # stop
```

### Where the database is

It is **not** in this stack. The inquiries live in the `bss_inquiries` schema on the company's
existing MariaDB server — the same host BlueAnt reporting uses — so Compose starts the app alone
and simply points it there.

Two consequences worth knowing. Backups are whatever that server already does; this project does
not arrange them. And `docker compose down -v` is harmless here, because there is no database
volume for it to delete.

The account in `DB_USER` should have rights on `bss_inquiries` and nothing else. If this app is
ever compromised, that account is the blast radius — and it shares a server with other data.

---

## Connecting the website to it

The website currently posts to a Google Apps Script. To send here as well, add two environment
variables to the website's deployment:

```
ADMIN_INGEST_URL=http://<this-server>:3100/api/inquiries
ADMIN_INGEST_TOKEN=<the same INGEST_TOKEN as in .env>
```

The website side is already written — see its `src/app/api/contact/route.ts`, after the Google call
succeeds. Two points in that code are deliberate and should survive any edit:

- The post is wrapped in **`after()`** from `next/server`, not left as a bare un-awaited `fetch`.
  The visitor's confirmation must not wait on this desk, but a promise nobody awaits can be frozen
  or killed when the response is sent — `after()` is the supported way to say "run this once the
  reply has gone out".
- A failure is **logged, never surfaced**. Google has already accepted the message at that point,
  so nothing is lost and there is nothing for the visitor to act on.

That is section 7 of the storage document: both destinations receive every message for two weeks,
which proves nothing is being lost, and only then is Google switched off.

---

## What it does today

- One list of inquiries, newest first
- Search across name, company, email, subject and message
- Filter by status, with counts
- Open a row to read the full message
- Set status (New / In progress / Answered / Spam), assign a colleague, write internal notes
- Export to CSV, opens straight in Excel
- Reply by email, address and subject prefilled

Everything in the "features that can be built" table in `ARCH-DQ-WEB-001` that is *not* in the
list above is deliberately absent. The document's own advice is to start with the simple list, let
the team use it, and add what turns out to be missing.

## What it does not do yet

- **No login** — see above
- **No automatic deletion.** Rule 4 of the document expects messages to be deleted after an agreed
  period, two years by default. That needs a scheduled job and an agreed period; neither exists yet.
- **No notification email.** Rule 7 expects one. The website already sends its own, so there is a
  second copy today, but this app does not send anything.
- **No import of the existing Google Sheet rows.** Step 4 of section 7.

---

## Shape of the code

```
db/schema.sql                one table, written to be re-runnable
scripts/init-db.mjs          applies it on boot, retries until the server answers
src/lib/inquiry.ts           type + status list — safe for client components
src/lib/db.ts                the pool and the queries — server only
src/app/page.tsx             loads the rows, renders the shell
src/app/InquiriesTable.tsx   the table: sorting, filters, search, pagination
src/app/InquiryDetail.tsx    the expanded row — full message and the write controls
src/app/ThemeControls.tsx    light/dark and the accent colour
src/app/actions.ts           status / assignee / notes writes
src/app/api/inquiries/       ingest from the website (token required)
src/app/api/export/          CSV of every inquiry
```

`inquiry.ts` is separate from `db.ts` on purpose: a client component importing from `db.ts` pulls
the MySQL driver into the browser bundle and the build fails on `dns`, `net` and `fs`.

Sorting and filtering happen in the browser, over the rows already loaded. That is why the export
is *everything* rather than the current view — the server has no way to know what is on screen, and
an export that silently dropped rows would be worse than one that includes them all.
