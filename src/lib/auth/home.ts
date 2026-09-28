import { UserRole } from '@/lib/enums';
import { can, type Viewer } from '@/lib/permissions';
import { MENTOR_DASHBOARD_PATH } from '@/lib/site';

/**
 * Where a signed-in account belongs when nothing more specific was asked for:
 * "/" for a live session, /login and /register for a visitor who is already
 * signed in, and the post-login default (completeLogin).
 *
 * A default, never authorization - /admin and the mentor panel each check the
 * live viewer themselves. Staff first, so an admin who also mentors still
 * lands on the panel they run.
 */
export function homePathFor(viewer: Viewer): string {
  if (viewer.role === UserRole.ADMIN || viewer.role === UserRole.MODERATOR) return '/admin';
  if (can(viewer, 'mentors:console')) return MENTOR_DASHBOARD_PATH;
  return '/dashboard';
}
