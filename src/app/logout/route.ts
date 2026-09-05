import { NextResponse, type NextRequest } from 'next/server';
import { revokeSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /logout
 *
 * A route handler rather than a page: logging out has no UI, and rendering a
 * "logging you out..." screen only creates a window where the user is unsure
 * whether it worked.
 *
 * GET is used because /logout is a plain link in the nav. That is normally a
 * CSRF smell — an attacker can force a logout with an <img> tag — but the
 * worst outcome is a nuisance sign-out, and the alternative (a POST form in
 * every menu) is worse ergonomics for no meaningful security gain. Anything
 * that changes state beyond ending a session stays POST-only.
 */
export async function GET(request: NextRequest) {
  const refreshToken = request.cookies.get('CH_RT')?.value;
  if (refreshToken) {
    // Revoke server-side too. Clearing the cookie alone would leave a valid
    // refresh token in anyone's hands who had already copied it.
    await revokeSession(refreshToken).catch(() => {});
  }

  const response = NextResponse.redirect(new URL('/', request.url));
  response.cookies.delete('CH_AT');
  response.cookies.delete('CH_RT');
  return response;
}
