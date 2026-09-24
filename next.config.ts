import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    /* standalone: `next build` emits .next/standalone with only the files and node_modules the
       server actually needs. That is what keeps the Docker image small and lets the runtime stage
       skip installing dependencies at all — see the Dockerfile. */
    output: 'standalone',

    /* This app is only ever reached inside the network and holds customer data. These headers do
       not replace that boundary; they are the cheap second layer.

       No CSP here on purpose: getting one wrong breaks the page in ways that are hard to debug,
       and with no third-party scripts or embeds there is nothing for it to constrain yet. Worth
       adding the day this app loads anything from outside itself. */
    async headers() {
        return [
            {
                source: '/:path*',
                headers: [
                    { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
                    { key: 'X-Content-Type-Options', value: 'nosniff' },
                    { key: 'X-Frame-Options', value: 'DENY' },
                    /* Inquiry URLs carry the search term, which can contain a customer's name.
                       Send no referrer at all rather than leak that to anything clicked from here. */
                    { key: 'Referrer-Policy', value: 'no-referrer' },
                ],
            },
        ];
    },
};

export default nextConfig;
