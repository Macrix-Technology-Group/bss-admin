import type { Metadata } from 'next';
import { Inter, Outfit } from 'next/font/google';
import './globals.css';

/* The BSS brand faces, the same two the public site uses: Outfit for headings and the wordmark,
   Inter for everything read at length. Loaded through next/font so they are self-hosted and carry
   no layout shift — the desk shows customer data and should not wait on a third-party font. */
const inter = Inter({ subsets: ['latin'], variable: '--font-body', display: 'swap' });
const outfit = Outfit({ subsets: ['latin'], variable: '--font-heading', display: 'swap' });

export const metadata: Metadata = {
    title: 'Inquiries — BSS LogisQ',
    /* Internal tool holding customer data: tell every crawler to stay out and not to keep a copy.
       Belt and braces with the network boundary, not a replacement for it — this only stops
       well-behaved crawlers, and it is the network that stops everyone else. */
    robots: { index: false, follow: false, nocache: true },
};

/* Applies a stored theme choice BEFORE the first paint.
 *
 * Without this, the page would paint in whatever the CSS defaults to and then jump when React
 * hydrated and the toggle re-applied the stored value — a white flash on every navigation for
 * anyone who has chosen dark. A blocking inline script in <head> is the one thing that runs early
 * enough to prevent it, which is why this is a string of raw JS rather than a component.
 *
 * It reads both the mode and the accent, so a chosen accent is on the sidebar and the buttons
 * from the first frame too. try/catch because localStorage throws outright in some privacy
 * modes; a theme is not worth a blank page. */
const NO_FLASH = `try{var d=document.documentElement;d.dataset.theme='dark';d.dataset.accent='blue';var t=localStorage.getItem('theme');if(t==='light'||t==='dark')d.dataset.theme=t;var a=localStorage.getItem('accent');if(a)d.dataset.accent=a;}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning className={`${inter.variable} ${outfit.variable}`}>
            <head>
                <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
            </head>
            <body>{children}</body>
        </html>
    );
}
