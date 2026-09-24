import { listInquiries } from '@/lib/db';

/* CSV of whatever the screen is currently showing — same search, same status filter, so "export
   what I can see" is literally true rather than approximately true.

   CSV rather than a real .xlsx: Excel opens it directly, it needs no library, and there is nothing
   in an inquiry that needs formatting. If the team later wants formulas or multiple sheets, that
   is the point to add a writer. */

export const dynamic = 'force-dynamic';

/* RFC 4180: wrap every field in quotes and double any quote inside it.

   The leading apostrophe on =, +, - and @ is CSV injection defence. Excel treats a cell starting
   with = as a formula, so a visitor who writes `=HYPERLINK(...)` in the message box would have it
   execute on the machine of whoever opens the export. The apostrophe makes Excel read it as text
   and is not shown in the cell. */
function cell(value: unknown): string {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
}

export async function GET() {
    /* Everything, not the current view. Filtering now lives in the browser (see
       InquiriesTable), so the server has no way to know what is on screen — and an export that
       silently omitted rows would be worse than one that includes them all. The team filters the
       spreadsheet, which is what a spreadsheet is for. */
    const rows = await listInquiries({ limit: 10_000 });

    const header = [
        'Received', 'First name', 'Last name', 'Company', 'Email', 'Phone',
        'Subject', 'Message', 'Status', 'Handled by', 'Notes', 'Language',
        'Consent', 'Privacy version',
    ];

    const body = rows.map((r) =>
        [
            new Date(r.received_at).toLocaleString('de-DE'),
            r.first_name, r.last_name, r.company, r.email, r.phone,
            r.subject, r.message, r.status, r.assignee, r.notes, r.locale,
            r.consent_given ? 'yes' : 'no', r.privacy_version,
        ].map(cell).join(','),
    );

    /* \r\n line endings and a UTF-8 BOM: without the BOM, Excel on Windows opens the file in the
       system codepage and every ä, ö and ü in a German inquiry arrives as mojibake. */
    const csv = '﻿' + [header.map(cell).join(','), ...body].join('\r\n');

    const stamp = new Date().toISOString().slice(0, 10);

    return new Response(csv, {
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="inquiries-${stamp}.csv"`,
            'Cache-Control': 'no-store',
        },
    });
}
