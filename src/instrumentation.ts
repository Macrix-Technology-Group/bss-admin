/* Next's instrumentation hook. There is nothing to start here anymore.
 *
 * Mail replies used to be collected by a background timer that ran every 60 seconds for the life of
 * the process. That is now done on demand when the admin page loads (see src/app/page.tsx →
 * maybePoll): the desk fetches replies when someone is actually looking at it, and does no idle
 * work when no one is. It also removes any need for a public webhook endpoint — the server only
 * reaches out to Graph, which works from inside the private network where this desk runs.
 *
 * Kept as a no-op so the hook has something to call. */
export async function register() {}
