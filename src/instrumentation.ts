/* Next's instrumentation hook. There is nothing to start here.
 *
 * Mail replies are fetched on page load (see src/app/page.tsx), and the database connection is kept
 * healthy by the pool settings and retry in src/lib/db.ts — closing idle connections quickly, a
 * query timeout, and a one-shot retry on a stale connection. So there is no background timer to run.
 *
 * Kept as a no-op so the hook has something to call. */
export async function register() {}
