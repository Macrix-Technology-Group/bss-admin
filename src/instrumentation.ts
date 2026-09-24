/* Next's instrumentation hook — runs once when the server process starts.
 *
 * Its only job is a database KEEP-ALIVE: a tiny `SELECT 1` every few minutes so the pooled
 * connection to Supabase (and its compute) never goes cold. Without it, the first page load after
 * the desk has been idle for a while is slow while a cold connection is re-established; with it, a
 * warm connection is always ready.
 *
 * This is NOT the mail poller — mail is fetched on page load (see src/app/page.tsx). This is one
 * cheap round trip on a timer, purely to keep the connection warm.
 *
 * Safe here because the desk runs as ONE long-lived container: a single process holds the timer.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return; // not the edge runtime or the build
    if (process.env.DEMO_DATA === '1') return; // demo screen opens no connection
    if (!process.env.DATABASE_URL) return; // nothing to keep warm until the database is wired up

    /* One timer per process, kept on globalThis so Next's dev-server reloads do not stack several. */
    const g = globalThis as unknown as { __dbKeepAlive?: NodeJS.Timeout };
    if (g.__dbKeepAlive) return;

    const intervalMs = Number(process.env.DB_KEEPALIVE_INTERVAL_MS ?? 4 * 60_000);

    const ping = async () => {
        try {
            const { keepAlive } = await import('@/lib/db');
            await keepAlive();
        } catch (err) {
            console.error('[db keep-alive] failed:', err);
        }
    };

    ping(); // warm the connection at boot so the very first visit is fast too
    g.__dbKeepAlive = setInterval(ping, intervalMs);
    console.log(`[db keep-alive] on — every ${Math.round(intervalMs / 1000)}s`);
}
