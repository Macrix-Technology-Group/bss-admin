import { ImageResponse } from 'next/og';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* The link-preview card, shown when the desk's URL is pasted into a chat or mail. Generated rather
   than a static file so it always matches the brand colours here — a navy panel with the logo and a
   one-line label. Node runtime (not edge) because it reads the logo off disk. */
export const runtime = 'nodejs';
export const alt = 'BSS LogisQ — Inquiry Desk';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/* The logo as a data URI. Read once; if it is missing the card falls back to a wordmark in text. */
const LOGO = (() => {
    try {
        return `data:image/png;base64,${readFileSync(join(process.cwd(), 'public', 'bss-logisq-email.png')).toString('base64')}`;
    } catch {
        return '';
    }
})();

export default function Image() {
    return new ImageResponse(
        (
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'linear-gradient(135deg, #0f2942 0%, #123a5e 100%)',
                    color: '#ffffff',
                }}
            >
                {LOGO ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={LOGO} alt="BSS LogisQ" width={420} />
                ) : (
                    <div style={{ fontSize: 84, fontWeight: 800 }}>BSS LogisQ</div>
                )}
                <div style={{ display: 'flex', marginTop: 34, fontSize: 40, color: '#9fc4e6' }}>
                    Inquiry Desk
                </div>
            </div>
        ),
        { ...size },
    );
}
