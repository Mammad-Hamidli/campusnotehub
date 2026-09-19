import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/LoginForm';
import { getViewer } from '@/lib/auth/session';
import { UserRole } from '@/lib/enums';

export const metadata: Metadata = { title: 'Log in', robots: { index: false, follow: false } };

/**
 * Never prerendered and never cached: what this route returns - the form, or a
 * redirect to a signed-in area - depends entirely on live session state.
 */
export const dynamic = 'force-dynamic';

/**
 * The sign-in screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THE "ALREADY SIGNED IN" CHECK LIVES HERE AND NOT IN THE MIDDLEWARE
 * ---------------------------------------------------------------------------
 * The middleware used to redirect /login to /dashboard whenever the CH_AT
 * cookie carried a signature that had not expired yet. It runs at the edge with
 * no database, so that was the only question it could ask - and it is the wrong
 * one. A token stays cryptographically valid for the rest of its TTL after the
 * session behind it has been revoked, so signing out and returning to /login
 * bounced the visitor straight into the app without a single credential being
 * checked. That is the reported bug: "the login page logs me back in by
 * itself."
 *
 * This page runs in Node and can ask the right question. getViewer() goes
 * through requireSession(), which reads the session row and the account row, so
 * it forwards only a session that is live RIGHT NOW - revoked, expired, idle
 * and banned all fall through to the form, which is the required behaviour:
 * after signing out, this screen always asks for credentials.
 *
 * A stale CH_AT cookie is deliberately left alone rather than being cleared via
 * a hop through /logout. It cannot do any harm - the middleware no longer reads
 * it as "signed in", every protected page re-checks live state, and every API
 * handler calls requireSession() - and clearing it here would be destructive in
 * a case that is not a problem at all: an access token that merely aged past
 * its fifteen minutes while the session behind it is perfectly healthy. Turning
 * "someone opened the login page" into "every one of their tabs is signed out"
 * is not a fix, it is a new bug. Signing in overwrites the cookie anyway.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const viewer = await getViewer();

  if (viewer) {
    /** Same-origin paths only - `//host` and `/\host` would be open redirects. */
    const safeNext = next && /^\/(?![/\\])/.test(next) ? next : null;
    const home =
      viewer.role === UserRole.ADMIN || viewer.role === UserRole.MODERATOR ? '/admin' : '/dashboard';
    redirect(safeNext ?? home);
  }

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-12">
      <LoginForm />
    </main>
  );
}
