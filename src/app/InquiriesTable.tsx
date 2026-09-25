'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
    flexRender,
    getCoreRowModel,
    getFacetedRowModel,
    getFacetedUniqueValues,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    useReactTable,
    type ColumnDef,
    type ColumnFiltersState,
    type OnChangeFn,
    type SortingState,
} from '@tanstack/react-table';
import { STATUSES, TEAM, type Inquiry, type InquiryEvent, type InquiryMessage } from '@/lib/inquiry';
import InquiryDetail from './InquiryDetail';

/* The status value the "All" tab (and every non-Spam view) filters by: everything except spam.
   Spam is deliberately walled off — it only ever appears when the Spam tab itself is selected — so
   "All" cannot be the plain "no filter" it usually is, or spam would leak into it. */
const NONSPAM = '__nonspam';

/* The inquiry list, on TanStack Table.
 *
 * Headless by design: the library owns sorting, filtering, faceting and pagination as state, and
 * renders nothing. Every element below is the same markup and the same CSS variables as before, so
 * the table inherits light/dark and the accent colour without knowing they exist.
 *
 * ── Why the filtering moved to the client ──
 * It used to live in the URL and run as SQL. Sorting by any column and filtering per column would
 * have meant a round trip per click and a growing WHERE clause. The page already loads at most 500
 * rows, which is nothing to filter in memory, so the table does it and the server query stays one
 * plain SELECT. The trade: a filtered view is no longer a bookmarkable URL. Worth revisiting if
 * this ever holds tens of thousands of rows — at which point server-side pagination is the answer,
 * and TanStack supports that with the same component.
 */

/* Sorts blank last regardless of direction. Postgres would put NULLs at one end and the reverse at
   the other; here an unassigned inquiry is "no answer", not a value that belongs at the top when
   you sort ascending. */
/* The columns the search can be narrowed to. Typing "@" in the search box offers these; picking
   one scopes every keystroke after it to that column alone. Status is left out — the tabs already
   filter it — and Received is a date, not something you free-text search. */
const SEARCH_SCOPES = [
    { id: 'from', label: 'From', hint: 'name & company' },
    { id: 'email', label: 'Contact', hint: 'email & phone' },
    { id: 'subject', label: 'Subject', hint: 'subject line' },
    { id: 'assignee', label: 'Handled by', hint: 'assignee' },
] as const;

/* Wraps every case-insensitive occurrence of `term` in the text with a <mark>, so the search
   term lights up where it matched. Splits on the match rather than using dangerouslySetInnerHTML —
   the text is a customer's own name and message, and must never be treated as markup. */
function markMatches(text: string, term: string): React.ReactNode {
    if (!term) return text;
    const lower = text.toLowerCase();
    const needle = term.toLowerCase();
    const parts: React.ReactNode[] = [];
    let from = 0;
    let key = 0;
    for (;;) {
        const at = lower.indexOf(needle, from);
        if (at === -1) {
            parts.push(text.slice(from));
            break;
        }
        if (at > from) parts.push(text.slice(from, at));
        parts.push(
            <mark className="hl" key={key++}>{text.slice(at, at + needle.length)}</mark>,
        );
        from = at + needle.length;
    }
    return parts;
}

/* Shown wherever a cell has no data — a soft dashed "Empty" tag, so a gap reads as "not filled
   in" rather than a bare dash or a broken-looking blank. */
function EmptyTag({ title }: { title?: string }) {
    return <span className="emptySlot" title={title}>Empty</span>;
}

/* The website substitutes "—" for an optional field the visitor left blank (last name, company),
   because the desk's columns are required. Treat that placeholder — and any blank — as empty, so the
   table shows the "Empty" tag everywhere instead of a bare dash. */
function isBlank(v: string | null | undefined): boolean {
    const s = (v ?? '').trim();
    return s === '' || s === '—' || s === '-';
}

/* First and last joined, dropping a blank or placeholder part, so a one-name sender reads as
   "Sherin" rather than "Sherin —". */
function fullName(first: string | null, last: string | null): string {
    return [first, last].filter((p) => !isBlank(p)).join(' ').trim();
}

/* Status badge: a lifecycle track that fills as the inquiry advances New 1/3 → In progress 2/3 →
   Answered 3/3, with the label in the status colour. Two states sit outside that pipeline and keep
   the same badge width so the column stays a tidy stack: Closed shows one solid bar, Spam shows a
   ban icon (a circle with a line through it). */
const STATUS_META: Record<string, { filled: number; kind: 'track' | 'bar' | 'ban' }> = {
    new:         { filled: 1, kind: 'track' },
    in_progress: { filled: 2, kind: 'track' },
    answered:    { filled: 3, kind: 'track' },
    closed:      { filled: 0, kind: 'bar' },
    spam:        { filled: 0, kind: 'ban' },
};

function StatusPill({ value }: { value: string }) {
    const meta = STATUS_META[value];
    const label = STATUSES.find((s) => s.value === value)?.label ?? value;
    return (
        <span className="pill" data-s={value}>
            <span className="pillTrack" aria-hidden="true">
                {meta?.kind === 'track' &&
                    [0, 1, 2].map((i) => (
                        <span key={i} className="pillSeg" data-on={i < meta.filled} />
                    ))}
                {meta?.kind === 'bar' && <span className="pillSeg pillSegFull" data-on="true" />}
                {meta?.kind === 'ban' && (
                    <svg className="pillIcon" viewBox="0 0 16 16">
                        <circle cx="8" cy="8" r="6.2" />
                        <line x1="3.7" y1="3.7" x2="12.3" y2="12.3" />
                    </svg>
                )}
            </span>
            <span className="pillLabel">{label}</span>
        </span>
    );
}

const blanksLast = (a: string | null, b: string | null) => {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
};

/* First letter of the first name and of the last, for the avatar. Falls back to the first two
   letters of whatever single word there is, so a one-word sender still gets a filled circle. */
function initials(first: string, last: string): string {
    const a = first.trim()[0] ?? '';
    const b = last.trim()[0] ?? first.trim()[1] ?? '';
    return (a + b).toUpperCase();
}

/* A stable hue per person, so the same sender is always the same colour and the eye can track a
   name down the list without reading it. A plain character sum is enough — this decides a colour,
   not anything that matters — and stepping by 47° keeps adjacent names apart on the wheel. */
function avatarStyle(seed: string): React.CSSProperties {
    let sum = 0;
    for (let i = 0; i < seed.length; i++) sum += seed.charCodeAt(i);
    const hue = (sum * 47) % 360;
    return {
        // Soft fill, saturated text: legible on the light table and never shouting.
        background: `hsl(${hue} 70% 94%)`,
        color: `hsl(${hue} 55% 34%)`,
    };
}

/* A well-mixed hash of the seed, so small changes in a name give very different avatars. FNV-1a. */
function seedHash(seed: string): number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/* A generated mesh-gradient avatar — no letters. Four soft colour blobs in a harmonious spread of
   hues, positioned from the seed and blurred together into one smooth aura, the way the modern
   gradient avatars (Linear, Stripe) look. Same company, same aura. Deterministic and offline —
   the blur is an SVG filter, nothing is fetched. */
function GeneratedAvatar({ seed }: { seed: string }) {
    const h = seedHash(seed || '?');
    const base = h % 360;
    /* Three analogous hues plus one opposite accent — vivid but never clashing. */
    const hues = [base, (base + 45) % 360, (base + 90) % 360, (base + 300) % 360];
    const id = `mesh${h}`;

    /* Blob centres pulled from different slices of the hash so they scatter across the disc. */
    const blobs = [
        { cx: 8 + (h % 10), cy: 8 + ((h >> 3) % 10), hue: hues[0] },
        { cx: 20 + ((h >> 6) % 12), cy: 6 + ((h >> 9) % 12), hue: hues[1] },
        { cx: 6 + ((h >> 12) % 14), cy: 20 + ((h >> 15) % 12), hue: hues[2] },
        { cx: 20 + ((h >> 18) % 12), cy: 20 + ((h >> 21) % 12), hue: hues[3] },
    ];

    return (
        <svg className="avatar" viewBox="0 0 38 38" width="38" height="38" aria-hidden="true">
            <defs>
                <filter id={id} x="-30%" y="-30%" width="160%" height="160%">
                    <feGaussianBlur stdDeviation="6" />
                </filter>
            </defs>
            <g filter={`url(#${id})`}>
                <rect width="38" height="38" fill={`hsl(${hues[0]} 70% 58%)`} />
                {blobs.map((b, i) => (
                    <circle key={i} cx={b.cx} cy={b.cy} r="13" fill={`hsl(${b.hue} 78% 60%)`} />
                ))}
            </g>
        </svg>
    );
}

export default function InquiriesTable({
    rows,
    events = {},
    messages = {},
}: {
    rows: Inquiry[];
    /* Keyed by inquiry id, newest first. Defaulted rather than required so demo mode — which has
       no database and therefore no history — needs no special case. */
    events?: Record<string, InquiryEvent[]>;
    /* Same shape, same reason: the conversation for every row, fetched once. */
    messages?: Record<string, InquiryMessage[]>;
}) {
    /* '__order' is always the first sort key and the user cannot remove it (see setSortingPinned):
       it forces closed inquiries to the bottom whatever else the table is sorted by. 'received_at'
       is the visible default beneath it. */
    const [sorting, setSorting] = useState<SortingState>([
        { id: '__order', desc: false },
        { id: 'received_at', desc: true },
    ]);
    /* Starts on the status filter, not empty: the baseline view is "everything except spam", so the
       status column always carries at least NONSPAM. */
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([
        { id: 'status', value: NONSPAM },
    ]);

    /* Whatever the user sorts by, keep '__order' pinned in front so closed rows never rise out of
       the bottom. A header click replaces the sort with a single column; this re-prepends ours. */
    const setSortingPinned: OnChangeFn<SortingState> = (updater) => {
        setSorting((old) => {
            const next = typeof updater === 'function' ? updater(old) : updater;
            const userSorts = next.filter((s) => s.id !== '__order');
            return [{ id: '__order', desc: false }, ...userSorts];
        });
    };

    /* Safety net: the status column must always carry a filter, because "no status filter" would
       fall through and show spam in every view. If anything ever leaves it empty, restore the
       NONSPAM baseline. */
    useEffect(() => {
        if (!columnFilters.some((f) => f.id === 'status')) {
            setColumnFilters((cf) => [...cf, { id: 'status', value: NONSPAM }]);
        }
    }, [columnFilters]);

    const [globalFilter, setGlobalFilter] = useState('');
    const [expanded, setExpanded] = useState<string | null>(null);
    /* Whether the per-column boxes are shown at all — see the toggle in the bar below. */
    const [showColFilters, setShowColFilters] = useState(false);

    /* Scoped search. `query` is what is typed in the box; `scope` is the column it is confined to,
       or null for a search across the whole inquiry. `atOpen` shows the column menu while the text
       still begins with "@". Kept separate from globalFilter/columnFilters so the box can drive
       either one without the two fighting over the input's value. */
    const [query, setQuery] = useState('');
    const [scope, setScope] = useState<string | null>(null);
    const [atOpen, setAtOpen] = useState(false);
    const searchRef = useRef<HTMLInputElement>(null);

    /* What to light up in the cells: the current search text, unless the "@" menu is open (the
       "@from" is a command, not something to find in the data). */
    const highlightTerm = !atOpen && query && !query.startsWith('@') ? query : '';

    /* Highlights matches of the search term in a cell — but only in the column the search applies
       to: everything under a global search, or just the scoped column under a scoped one. Held in
       a ref so the memoised column definitions always call the current version without being
       rebuilt on every keystroke. */
    const hl = (text: string | null | undefined, colId: string): React.ReactNode => {
        const value = text ?? '';
        if (!highlightTerm) return value;
        if (scope && scope !== colId) return value;
        return markMatches(value, highlightTerm);
    };
    const hlRef = useRef(hl);
    hlRef.current = hl;

    const columns = useMemo<ColumnDef<Inquiry>[]>(
        () => [
            {
                /* Never rendered (hidden via columnVisibility) — it exists only to sort. Kept as the
                   first sort key, it parks every closed inquiry below the rest: closed rows sort
                   after open ones, and among themselves oldest-closed first so the most recently
                   closed sits at the very bottom (updated_at moves to now() when a status changes).
                   Returning 0 for two open rows lets the user's own column sort decide their order. */
                id: '__order',
                accessorFn: () => 0,
                enableColumnFilter: false,
                sortingFn: (a, b) => {
                    const ca = a.original.status === 'closed';
                    const cb = b.original.status === 'closed';
                    if (ca !== cb) return ca ? 1 : -1;
                    if (ca && cb) {
                        return (
                            new Date(a.original.updated_at).getTime() -
                            new Date(b.original.updated_at).getTime()
                        );
                    }
                    return 0;
                },
            },
            {
                /* The inquiry's reference — the same "BSS-MX-<id>" that goes in the email subject, so
                   a reply tagged [BSS-MX-42] can be found here at a glance. */
                id: 'ref',
                accessorKey: 'id',
                header: 'Ref',
                enableColumnFilter: false,
                cell: ({ getValue }) => (
                    <span className="nowrap muted refCell">BSS-MX-{getValue<string>()}</span>
                ),
            },
            {
                id: 'received_at',
                accessorKey: 'received_at',
                header: 'Received',
                enableColumnFilter: false,
                cell: ({ getValue }) => {
                    const d = new Date(getValue<string>());
                    return (
                        <span className="nowrap muted">
                            {d.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}
                            <br />
                            <span style={{ fontSize: 12 }}>
                                {d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}
                            </span>
                        </span>
                    );
                },
            },
            {
                id: 'from',
                /* One column, two fields. Sorting and filtering "From" should consider the person
                   AND the company, because that is how someone thinks about it — they remember
                   "the one from Hofmeister" without remembering the name. */
                accessorFn: (r) =>
                    [fullName(r.first_name, r.last_name), isBlank(r.company) ? '' : r.company]
                        .filter(Boolean)
                        .join(' '),
                header: 'From',
                filterFn: 'includesString',
                cell: ({ row }) => {
                    const name = fullName(row.original.first_name, row.original.last_name);
                    const company = row.original.company;
                    return (
                        <div className="fromCell">
                            <GeneratedAvatar seed={isBlank(company) ? name || row.original.email : company} />
                            <div>
                                <div className="who">
                                    {name ? hlRef.current(name, 'from') : <EmptyTag title="No name" />}
                                </div>
                                <div className="muted">
                                    {isBlank(company)
                                        ? <EmptyTag title="No company" />
                                        : hlRef.current(company, 'from')}
                                </div>
                            </div>
                        </div>
                    );
                },
            },
            {
                id: 'email',
                accessorKey: 'email',
                header: 'Contact',
                filterFn: 'includesString',
                cell: ({ row }) => (
                    <>
                        <a href={`mailto:${row.original.email}`} onClick={(e) => e.stopPropagation()}>
                            {hlRef.current(row.original.email, 'email')}
                        </a>
                        <div className="muted">
                            {row.original.phone
                                ? hlRef.current(row.original.phone, 'email')
                                : <EmptyTag title="No phone number" />}
                        </div>
                    </>
                ),
            },
            {
                id: 'subject',
                accessorKey: 'subject',
                header: 'Subject',
                filterFn: 'includesString',
                cell: ({ row }) => (
                    <span className="subject" title={row.original.subject}>
                        {hlRef.current(row.original.subject, 'subject')}
                    </span>
                ),
            },
            {
                id: 'status',
                accessorKey: 'status',
                header: 'Status',
                /* A specific value matches that status exactly (a choice from a fixed list — "New"
                   must not also match a hypothetical "Newly assigned"). The NONSPAM sentinel, which
                   the "All" tab and every non-Spam view carry, matches everything except spam: spam
                   is only ever shown when the Spam tab is selected. */
                filterFn: (row, id, value) => {
                    const s = row.getValue<string>(id);
                    return value === NONSPAM ? s !== 'spam' : s === value;
                },
                cell: ({ getValue }) => <StatusPill value={getValue<string>()} />,
            },
            {
                id: 'assignee',
                accessorKey: 'assignee',
                header: 'Handled by',
                filterFn: 'includesString',
                sortingFn: (a, b) =>
                    blanksLast(a.original.assignee, b.original.assignee),
                cell: ({ getValue }) => {
                    const v = getValue<string>();
                    return v ? (
                        <span className="muted nowrap">{hlRef.current(v, 'assignee')}</span>
                    ) : (
                        <EmptyTag title="Unassigned" />
                    );
                },
            },
        ],
        [],
    );

    /* Controlled, not initialState: '__order' must stay hidden for good. As initialState it only
       seeds the first mount, which a dev hot-reload can skip — leaving the helper column on screen. */
    const columnVisibility = useMemo(() => ({ __order: false }), []);

    const table = useReactTable({
        data: rows,
        columns,
        state: { sorting, columnFilters, globalFilter, columnVisibility },
        onSortingChange: setSortingPinned,
        onColumnFiltersChange: setColumnFilters,
        onGlobalFilterChange: setGlobalFilter,
        /* The search box searches the whole inquiry, including the message body, which is not a
           column. Without this the global filter would only see rendered columns and "cold store"
           would miss a message that mentions it. */
        globalFilterFn: (row, _id, value) => {
            const q = String(value).toLowerCase();
            const r = row.original;
            return [r.first_name, r.last_name, r.company, r.email, r.subject, r.message, r.assignee, r.notes]
                .join(' ')
                .toLowerCase()
                .includes(q);
        },
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getFacetedRowModel: getFacetedRowModel(),
        getFacetedUniqueValues: getFacetedUniqueValues(),
        getPaginationRowModel: getPaginationRowModel(),
        initialState: { pagination: { pageSize: 25 } },
    });

    const statusCol = table.getColumn('status');
    /* Counts come from the FACETED row model, so each status shows how many rows it would give
       under the other active filters — not the total. Searching "cold" and seeing "New 12" when
       only one matches is the bug this avoids. */
    const statusCounts = statusCol?.getFacetedUniqueValues() ?? new Map();

    const filtered = table.getFilteredRowModel().rows.length;

    /* The status the tabs are on. NONSPAM is the baseline ("All"), so it does not count as a filter
       the user has applied — otherwise Clear would always show and the empty state would always
       read "no matches". Per-column text filters and a real status choice do count. */
    const statusFilterValue = (statusCol?.getFilterValue() as string | undefined) ?? NONSPAM;
    const colFiltersApplied = columnFilters.filter((f) => f.id !== 'status');
    const anyFilter =
        globalFilter !== '' ||
        colFiltersApplied.length > 0 ||
        statusFilterValue !== NONSPAM ||
        scope !== null;

    /* "All" shows every inquiry except spam — spam has its own tab and appears nowhere else. */
    const allCount = rows.reduce((n, r) => (r.status === 'spam' ? n : n + 1), 0);

    /* The active scope, and the columns the "@" menu is currently offering (filtered by whatever
       has been typed after the "@"). */
    const activeScope = SEARCH_SCOPES.find((s) => s.id === scope) ?? null;
    const atQuery = atOpen ? query.slice(1).toLowerCase() : '';
    const atMatches = SEARCH_SCOPES.filter((s) => s.label.toLowerCase().includes(atQuery));

    /* Every keystroke in the search box. With no scope, a leading "@" opens the column menu and
       holds off filtering until a column is chosen; anything else is a search across the whole
       inquiry. With a scope set, the text filters that one column instead. */
    function onSearch(value: string) {
        setQuery(value);
        if (!scope && value.startsWith('@')) {
            setAtOpen(true);
            return;
        }
        setAtOpen(false);
        if (scope) table.getColumn(scope)?.setFilterValue(value);
        else setGlobalFilter(value);
    }

    /* Picking a column from the "@" menu. Clears the global search, starts an empty filter on the
       chosen column, and returns focus so typing continues straight into the scoped search. */
    function pickScope(id: string) {
        setGlobalFilter('');
        setScope(id);
        setQuery('');
        setAtOpen(false);
        table.getColumn(id)?.setFilterValue('');
        requestAnimationFrame(() => searchRef.current?.focus());
    }

    /* Back to searching everything. */
    function clearScope() {
        if (scope) table.getColumn(scope)?.setFilterValue(undefined);
        setScope(null);
        setQuery('');
        setAtOpen(false);
        requestAnimationFrame(() => searchRef.current?.focus());
    }

    function clearAll() {
        setGlobalFilter('');
        /* Back to the baseline, not empty: an empty status filter would let spam back into the list. */
        setColumnFilters([{ id: 'status', value: NONSPAM }]);
        setScope(null);
        setQuery('');
        setAtOpen(false);
    }

    return (
        <>
            {/* One control bar: the status tabs on the left, and search + column filters pushed to
                the right. The search used to sit in its own row above; folded in here it saves a
                line and keeps every way of narrowing the list — by status, by text, by column — on
                one row. */}
            <div className="bar tabs">
                <button
                    type="button"
                    className="tab"
                    data-on={statusFilterValue === NONSPAM}
                    onClick={() => statusCol?.setFilterValue(NONSPAM)}
                >
                    All <span className="n">{allCount}</span>
                </button>
                {STATUSES.map((s) => (
                    <button
                        key={s.value}
                        type="button"
                        className="tab"
                        data-on={statusFilterValue === s.value}
                        onClick={() =>
                            statusCol?.setFilterValue(statusFilterValue === s.value ? NONSPAM : s.value)
                        }
                    >
                        {s.label} <span className="n">{statusCounts.get(s.value) ?? 0}</span>
                    </button>
                ))}

                <div className="barRight">
                    <div className="searchWrap">
                        {/* When a column is scoped, a chip in front of the field names it and
                            clears it. */}
                        {activeScope && (
                            <span className="scopeChip">
                                {activeScope.label}
                                <button type="button" onClick={clearScope} aria-label="Search everything again">
                                    ×
                                </button>
                            </span>
                        )}
                        <input
                            ref={searchRef}
                            id="inquiry-search"
                            name="inquiry-search"
                            type="search"
                            value={query}
                            onChange={(e) => onSearch(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') setAtOpen(false);
                                /* Backspace on an empty scoped box drops the scope, the way
                                   deleting a token feels like it should. */
                                if (e.key === 'Backspace' && scope && query === '') clearScope();
                            }}
                            /* A short delay so a click on a menu row lands before blur hides it. */
                            onBlur={() => setTimeout(() => setAtOpen(false), 120)}
                            onFocus={() => { if (!scope && query.startsWith('@')) setAtOpen(true); }}
                            placeholder={activeScope ? `Search in ${activeScope.label}…` : 'Search…  (type @ for a column)'}
                            aria-label="Search inquiries"
                        />

                        {atOpen && atMatches.length > 0 && (
                            <div className="atMenu" role="listbox" aria-label="Search a column">
                                {atMatches.map((s) => (
                                    <button
                                        key={s.id}
                                        type="button"
                                        role="option"
                                        aria-selected="false"
                                        className="atOption"
                                        /* mouseDown, not click: it fires before the input's blur,
                                           so the menu is still open when the pick runs. */
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            pickScope(s.id);
                                        }}
                                    >
                                        <span className="atAt" aria-hidden="true">@</span>
                                        <span className="atLabel">{s.label}</span>
                                        <span className="atDesc">{s.hint}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Turns the per-column boxes on and off. Off by default: they add a second
                        line to every header, and most searching is done with the box beside them.
                        Switching them OFF clears them, so a filter never stays applied with the
                        control that set it hidden. */}
                    <button
                        type="button"
                        className="tab"
                        data-on={showColFilters}
                        aria-pressed={showColFilters}
                        onClick={() => {
                            /* Drop the per-column boxes but keep the status baseline, or spam would
                               reappear the moment the filters are hidden. */
                            if (showColFilters)
                                setColumnFilters((cf) => cf.filter((f) => f.id === 'status'));
                            setShowColFilters((v) => !v);
                        }}
                    >
                        Columns
                        {colFiltersApplied.length > 0 && <span className="n">{colFiltersApplied.length}</span>}
                    </button>

                    {anyFilter && (
                        <button type="button" className="tab" onClick={clearAll}>
                            Clear
                        </button>
                    )}
                </div>
            </div>

            <div className="card">
                <div className="scroll">
                    <table>
                        <thead>
                            {table.getHeaderGroups().map((hg) => (
                                <tr key={hg.id}>
                                    {hg.headers.map((h) => {
                                        const sorted = h.column.getIsSorted();
                                        return (
                                            <th key={h.id}>
                                                {h.column.getCanSort() ? (
                                                    <button
                                                        type="button"
                                                        className="sortBtn"
                                                        onClick={h.column.getToggleSortingHandler()}
                                                        /* Screen readers get the state; the arrow
                                                           alone is invisible to them. */
                                                        aria-sort={
                                                            sorted === 'asc'
                                                                ? 'ascending'
                                                                : sorted === 'desc'
                                                                  ? 'descending'
                                                                  : 'none'
                                                        }
                                                    >
                                                        {flexRender(h.column.columnDef.header, h.getContext())}
                                                        <span className="sortArrow" data-on={!!sorted}>
                                                            {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}
                                                        </span>
                                                    </button>
                                                ) : (
                                                    flexRender(h.column.columnDef.header, h.getContext())
                                                )}

                                                {showColFilters &&
                                                    h.column.getCanFilter() &&
                                                    h.column.id !== 'status' &&
                                                    /* Assignee is a closed set, so it gets a list
                                                       rather than a text box — the same names as
                                                       the editor, so filtering cannot be defeated
                                                       by a typo or a half-typed surname. */
                                                    (h.column.id === 'assignee' ? (
                                                        <select
                                                            className="colFilter"
                                                            value={(h.column.getFilterValue() as string) ?? ''}
                                                            onChange={(e) =>
                                                                h.column.setFilterValue(e.target.value || undefined)
                                                            }
                                                            aria-label="Filter by who is handling it"
                                                        >
                                                            <option value="">Anyone</option>
                                                            {TEAM.map((name) => (
                                                                <option key={name} value={name}>
                                                                    {name}
                                                                </option>
                                                            ))}
                                                        </select>
                                                    ) : (
                                                        <input
                                                            className="colFilter"
                                                            value={(h.column.getFilterValue() as string) ?? ''}
                                                            onChange={(e) => h.column.setFilterValue(e.target.value)}
                                                            placeholder="Filter…"
                                                            aria-label={`Filter by ${h.column.id}`}
                                                        />
                                                    ))}
                                            </th>
                                        );
                                    })}
                                </tr>
                            ))}
                        </thead>

                        <tbody>
                            {table.getRowModel().rows.map((row) => (
                                /* Fragment, not <>: the key belongs on the outermost element of
                                   each iteration, and the shorthand cannot take one. */
                                <Fragment key={row.id}>
                                    {/* The whole row opens the inquiry — no separate button. A
                                        click inside a link or button (the email, say) is left to
                                        that control via the stopPropagation on it. */}
                                    <tr
                                        className="rowClickable"
                                        data-open={expanded === row.original.id}
                                        onClick={() =>
                                            setExpanded((v) => (v === row.original.id ? null : row.original.id))
                                        }
                                    >
                                        {row.getVisibleCells().map((cell) => (
                                            <td key={cell.id}>
                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                            </td>
                                        ))}
                                    </tr>
                                    {expanded === row.original.id && (
                                        <tr className="detail">
                                            <td colSpan={row.getVisibleCells().length}>
                                                <InquiryDetail
                                                    q={row.original}
                                                    history={events[row.original.id] ?? []}
                                                    thread={messages[row.original.id] ?? []}
                                                    onDone={() => setExpanded(null)}
                                                />
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>

                {filtered === 0 && (
                    <div className="empty">
                        <div className="emptyArt" aria-hidden="true">
                            {anyFilter ? (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="11" cy="11" r="7" />
                                    <path d="m21 21-4.3-4.3" />
                                </svg>
                            ) : (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
                                    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                                </svg>
                            )}
                        </div>

                        {anyFilter ? (
                            <>
                                <h3>No matches</h3>
                                <p>Nothing fits the current search or filters. Try a different term, or clear them to see everything.</p>
                                <button type="button" className="btn" onClick={clearAll}>Clear filters</button>
                            </>
                        ) : (
                            <>
                                <h3>No inquiries yet</h3>
                                <p>Messages from the website contact form land here automatically — nothing to set up.</p>
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* Pagination hides itself on one page rather than showing a dead control. */}
            {table.getPageCount() > 1 && (
                <div className="bar pager">
                    <button
                        type="button"
                        className="btn"
                        onClick={() => table.previousPage()}
                        disabled={!table.getCanPreviousPage()}
                    >
                        ← Previous
                    </button>
                    <span className="muted">
                        Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
                        {' · '}
                        {filtered} {filtered === 1 ? 'inquiry' : 'inquiries'}
                    </span>
                    <button
                        type="button"
                        className="btn"
                        onClick={() => table.nextPage()}
                        disabled={!table.getCanNextPage()}
                    >
                        Next →
                    </button>
                </div>
            )}
        </>
    );
}
