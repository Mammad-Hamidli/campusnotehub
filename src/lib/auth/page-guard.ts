import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE_ACCESS, getViewer } from '@/lib/auth/session';
import type { Viewer } from '@/lib/permissions';

export const SET_PASSWORD_PATH = '/set-password';

/**
 * The server-side session gate for protected PAGES.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MIDDLEWARE WAS NEVER ENOUGH
 * ---------------------------------------------------------------------------
 * middleware.ts runs at the edge with no database, so the only question it can
 * answer is "does this cookie hold a signature we minted that has not expired
 * yet". It cannot see `revokedAt`, which means it cannot tell a live session
 * from one that was revoked by signing out, by an admin, or by refresh-token
 * reuse detection.
 *
 * For /admin that gap was already covered: its layout calls getAdminViewer(),
 * which reads live state. Every other protected route had no second layer at
 * all - /dashboard, /wallet, /settings, /notifications, /profile, /bookmarks,
 * /bookings, /verify and /notes/purchases were rendering a full 200 for a
 * session that had been revoked, because nothing between the edge check and
 * the response ever consulted the database. That is the "logged out but still
 * signed in" report: the shell painted, and only the API calls inside it
 * noticed anything was wrong.
 *
 * This is the /admin layout's guarantee, generalised. It is deliberately a
 * shared helper rather than a copied block, so a new protected page gets the
 * real check by writing one line.
 *
 * It is NOT the security boundary - every API handler still calls
 * requireSession() independently, and that is what protects the data. This
 * stops a revoked session from being shown a signed-in shell.
 */
export async function requirePageSession(next: string): Promise<Viewer> {
  const viewer = await getViewer();
  if (viewer) {
    // A Google-only account owes a local password before anything else - see
    // the OAuth callback. /set-password itself is the one page it may open.
    if (viewer.passwordSetupRequired && next !== SET_PASSWORD_PATH) redirect(SET_PASSWORD_PATH);
    return viewer;
  }

  /**
   * Two different failures, two different destinations.
   *
   * A visitor with no access-token cookie was simply never signed in here, and
   * sending them through /logout would be a pointless extra hop.
   *
   * A visitor who HAS the cookie but whose session did not validate is holding
   * a dead credential, and it has to be deleted or the middleware will keep
   * treating it as a session and bouncing them away from /login - the exact
   * loop that made a revoked session look like a signed-in one. A server
   * component cannot write cookies, so the clearing is delegated to /logout,
   * which is a route handler and can.
   */
  const hasStaleCookie = (await cookies()).has(COOKIE_ACCESS);
  const login = `/login?next=${encodeURIComponent(next)}`;

  redirect(hasStaleCookie ? `/logout?next=${encodeURIComponent(login)}` : login);
}
