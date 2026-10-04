import { deleteCalendarLink, openRefreshToken } from '@/lib/firebase/repositories/calendarLinks';
import { forgetAccessToken, revokeGoogleToken } from './calendar';

/**
 * Removes a user's Google Calendar connection and revokes the grant at Google
 * (best effort - Google may already have dropped it). Used by the mentor's
 * Disconnect button and by account deletion, so a deleted account never
 * leaves a live calendar grant behind. Returns whether there was one.
 */
export async function disconnectCalendar(userId: string): Promise<boolean> {
  const link = await deleteCalendarLink(userId);
  forgetAccessToken(userId);
  if (!link) return false;
  try {
    await revokeGoogleToken(openRefreshToken(link));
  } catch {
    // Unopenable after a vault key change: the stored copy is gone either way.
  }
  return true;
}
