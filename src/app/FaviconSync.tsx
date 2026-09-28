'use client';

import { useEffect } from 'react';

/* Keeps the browser-tab favicon in step with the chosen accent.
 *
 * The favicon is a static file (app/icon.svg) by default, but the desk lets the team pick an accent
 * (blue, teal, violet, …) and switch light/dark, and the icon should follow. A file cannot read the
 * theme, so this rebuilds the warehouse mark from the live --accent value and swaps the <link> — on
 * mount and again whenever data-accent or data-theme changes on <html>. Two tones come from one
 * colour: the body is the accent, the roof the same accent at lower opacity over the navy tile. */
function warehouseSvg(accent: string): string {
    const navy = '#0f2942';
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
        + `<rect width="64" height="64" rx="15" fill="${navy}"/>`
        + `<polygon points="5,29 18,17 46,17 59,29" fill="${accent}" fill-opacity="0.72"/>`
        + `<rect x="11" y="28" width="42" height="24" rx="2" fill="${accent}"/>`
        + `<rect x="21" y="35" width="22" height="17" rx="1.5" fill="${navy}"/>`
        + `<line x1="21" y1="40" x2="43" y2="40" stroke="${accent}" stroke-width="1.6"/>`
        + `<line x1="21" y1="45" x2="43" y2="45" stroke="${accent}" stroke-width="1.6"/>`
        + `</svg>`
    );
}

export default function FaviconSync() {
    useEffect(() => {
        const root = document.documentElement;

        const apply = () => {
            const accent = getComputedStyle(root).getPropertyValue('--accent').trim() || '#2d8fc7';
            const href = 'data:image/svg+xml,' + encodeURIComponent(warehouseSvg(accent));
            /* Replace whatever icon links exist (Next injects one from app/icon.svg) with ours, so
               the tab shows exactly one favicon in the current accent. */
            document.querySelectorAll('link[rel~="icon"]').forEach((l) => l.remove());
            const link = document.createElement('link');
            link.rel = 'icon';
            link.type = 'image/svg+xml';
            link.href = href;
            document.head.appendChild(link);
        };

        apply();

        const obs = new MutationObserver((muts) => {
            if (muts.some((m) => m.attributeName === 'data-accent' || m.attributeName === 'data-theme')) {
                apply();
            }
        });
        obs.observe(root, { attributes: true, attributeFilter: ['data-accent', 'data-theme'] });
        return () => obs.disconnect();
    }, []);

    return null;
}
