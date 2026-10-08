import { UserRole } from '@/lib/enums';
import type { Viewer } from '@/lib/permissions';

/**
 * Where a signed-in account belongs when nothing more specific was asked for:
 * "/" for a live session, /login and /register for a visitor who is already
 * signed in, and the post-login default (completeLogin).
 *
 * A default, never authorization - /admin still checks the live viewer.
 */
export function homePathFor(viewer: Viewer): string {
  if (viewer.role === UserRole.ADMIN || viewer.role === UserRole.MODERATOR) return '/admin';
  // Mentors use the same student dashboard on sign-in; the mentor console is
  // still available from its explicit navigation link.
  return '/dashboard';
}
