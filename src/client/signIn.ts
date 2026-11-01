/**
 * The Cloudflare Access sign-in in front of the server (see
 * src/server/cloudflareAccess.ts), as the page sees it: a lapsed sign-in is
 * renewed by loading the page again, which goes through Cloudflare's login.
 * Behind tailscale serve or on a LAN there is no sign-in and none of this
 * ever triggers.
 */

const PROBE_MS = 5_000;
/** Reloads for a lapsed sign-in closer together than this stop and ask instead. */
const RELOAD_MIN_MS = 60_000;
const RELOAD_KEY = 'texwerk:signInReloadAt';

/**
 * Load the page again. If the last such reload was only moments ago, the
 * sign-in and the server disagree (a clock off, a policy changed): reloading
 * again would only loop, so say so instead.
 */
export function signInAgain(onStatus: (status: string) => void): void {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // No storage: reload anyway; a loop is still bounded by the sign-in page.
  }
  if (Date.now() - last < RELOAD_MIN_MS) {
    onStatus('your sign-in could not be renewed — reload the page to sign in again');
    return;
  }
  onStatus('your sign-in has expired — signing in again…');
  location.reload();
}

/**
 * Whether the server is now behind a sign-in this page no longer holds: the
 * request is answered with a redirect (to Cloudflare Access's login) rather
 * than by TeXWerk. Bounded, so a probe that never answers does not hold up
 * the reconnect.
 */
export async function signInLapsed(): Promise<boolean> {
  if (location.protocol !== 'https:') return false;
  try {
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), PROBE_MS);
    const response = await fetch('/api/me', {
      redirect: 'manual', cache: 'no-store', credentials: 'same-origin', signal: abort.signal,
    }).finally(() => clearTimeout(deadline));
    return response.type === 'opaqueredirect' || response.status === 401;
  } catch {
    return false;
  }
}
