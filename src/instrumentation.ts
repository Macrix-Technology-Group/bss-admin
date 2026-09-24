/* Runs once when the server process starts (Next's instrumentation hook). Its job is to start the
   mail poller on a timer, so replies are captured automatically — no cron, no manual curl.
 *
 * This is safe here in a way it would not be on a serverless host: the desk runs as ONE
 * long-lived container (next start), so there is a single process to hold the timer and no risk of
 * several instances polling the same mailbox at once. If the desk is ever scaled to more than one
 * instance, move this back to an external cron hitting /api/mail/poll and drop the timer.
 */
export async function register() {
    /* Only in the Node.js server runtime — not the edge runtime, not the build. */
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;
    if (process.env.DEMO_DATA === '1') return;

    const { mailConfigured } = await import('@/lib/mailPoll');

    /* Nothing to poll until the mailbox is configured. Without this the timer would throw and log
       every interval on a desk that has the database but not the mail credentials yet. */
    if (!mailConfigured()) {
        console.log('[mail poll] mail not configured — automatic capture is off');
        return;
    }

    /* Guard against the double-registration that Next's dev server can cause on reload: one timer
       per process, kept on globalThis. */
    const g = globalThis as unknown as { __mailPollTimer?: NodeJS.Timeout };
    if (g.__mailPollTimer) return;

    const intervalMs = Number(process.env.MAIL_POLL_INTERVAL_MS ?? 60_000);

    /* Import pollOnce fresh on each run rather than capturing it once here. In production this is a
       cached module either way; in development it means an edit to the poller takes effect on the
       next tick, instead of the timer holding the code as it was at server start. */
    const run = async () => {
        try {
            const { pollOnce } = await import('@/lib/mailPoll');
            await pollOnce();
        } catch (err) {
            console.error('[mail poll] run failed:', err);
        }
    };

    /* A first run shortly after start (so a reply waiting at boot is not held for a full interval),
       then every interval after. */
    setTimeout(run, 5_000);
    g.__mailPollTimer = setInterval(run, intervalMs);

    console.log(`[mail poll] automatic capture on — every ${Math.round(intervalMs / 1000)}s`);
}
