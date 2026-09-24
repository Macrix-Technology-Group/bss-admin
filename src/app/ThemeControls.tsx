'use client';

import { useEffect, useState } from 'react';

type Mode = 'light' | 'dark';

/* Light/dark, plus a swappable accent.
 *
 * The two are independent on purpose: the accent is one hue used for links, the active filter and
 * focus rings, and it has a light and a dark value so each swatch works in both modes. Choosing
 * violet does not commit you to dark.
 *
 * Both are written to <html> as data attributes and read back by CSS variables in globals.css —
 * no inline styles, so a swap costs one attribute change and the whole page follows.
 */

export const ACCENTS = [
    { id: 'blue', label: 'Blue', swatch: '#1d7fc0' },
    { id: 'teal', label: 'Teal', swatch: '#0f8b82' },
    { id: 'violet', label: 'Violet', swatch: '#6d4bd8' },
    { id: 'amber', label: 'Amber', swatch: '#b4700a' },
    { id: 'rose', label: 'Rose', swatch: '#c03a5e' },
    { id: 'slate', label: 'Slate', swatch: '#4b5a68' },
] as const;

type Accent = (typeof ACCENTS)[number]['id'];

export default function ThemeControls() {
    const [mode, setMode] = useState<Mode | null>(null);
    const [accent, setAccent] = useState<Accent>('blue');
    const [mounted, setMounted] = useState(false);
    const [open, setOpen] = useState(false);

    /* Nothing renders until mounted: the server cannot know what is in localStorage, so any label
       it guessed would be wrong half the time and React would report a hydration mismatch on
       exactly those loads. The flash this would otherwise cause is already handled by the inline
       script in layout.tsx, which runs before first paint. */
    useEffect(() => {
        setMounted(true);
        const el = document.documentElement;

        /* Dark is the default when nothing has been chosen — not the operating system's setting.
           The pre-paint script in layout.tsx stamps the same default to avoid a flash; we ALSO
           apply it here on mount so the page is correct even if that script did not take effect in
           the production build (which is what caused the accent to fall back to blue on refresh). */
        const storedMode = localStorage.getItem('theme');
        const m: Mode = storedMode === 'light' || storedMode === 'dark' ? storedMode : 'dark';
        setMode(m);
        el.dataset.theme = m;

        const storedAccent = localStorage.getItem('accent');
        const a: Accent =
            storedAccent && ACCENTS.some((x) => x.id === storedAccent) ? (storedAccent as Accent) : 'blue';
        setAccent(a);
        el.dataset.accent = a;
    }, []);

    const flipMode = () => {
        const next: Mode = mode === 'dark' ? 'light' : 'dark';
        setMode(next);
        localStorage.setItem('theme', next);
        document.documentElement.dataset.theme = next;
    };

    const pickAccent = (id: Accent) => {
        setAccent(id);
        localStorage.setItem('accent', id);
        document.documentElement.dataset.accent = id;
        setOpen(false);
    };

    if (!mounted) {
        return <span className="themeBtn" style={{ visibility: 'hidden' }}>Dark</span>;
    }

    const goingTo: Mode = mode === 'dark' ? 'light' : 'dark';

    return (
        <span className="themeControls">
            <span className="accentWrap">
                <button
                    type="button"
                    className="themeBtn accentBtn"
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                    aria-label="Change accent colour"
                >
                    <span className="swatch" style={{ background: 'var(--accent)' }} />
                    Colour
                </button>

                {open && (
                    <span className="accentMenu" role="listbox" aria-label="Accent colour">
                        {ACCENTS.map((a) => (
                            <button
                                key={a.id}
                                type="button"
                                role="option"
                                aria-selected={accent === a.id}
                                className="accentOption"
                                data-on={accent === a.id}
                                onClick={() => pickAccent(a.id)}
                            >
                                <span className="swatch" style={{ background: a.swatch }} />
                                {a.label}
                            </button>
                        ))}
                    </span>
                )}
            </span>

            <button
                type="button"
                className="themeBtn"
                onClick={flipMode}
                aria-label={`Switch to ${goingTo} mode`}
            >
                {goingTo === 'dark' ? '◐ Dark' : '◑ Light'}
            </button>
        </span>
    );
}
