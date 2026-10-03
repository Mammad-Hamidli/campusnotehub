import { adminDb } from '../admin.core';
import { COLLECTIONS } from '../collections';

/**
 * The feed's single ad slot: which mentor profile it promotes, if any.
 *
 * One document, `siteConfig/feedAd`, written only by staff through
 * /api/admin/feed-ad. It stores the profile id and nothing about the mentor,
 * so a profile that is later unapproved, paused or whose account is banned
 * simply stops being shown (see loadFeedAd) instead of lingering as a copy.
 */
const slot = () => adminDb().collection(COLLECTIONS.siteConfig).doc('feedAd');

export async function getFeedAdMentorId(): Promise<string | null> {
  const mentorId = (await slot().get()).get('mentorId');
  return typeof mentorId === 'string' && mentorId ? mentorId : null;
}

export async function setFeedAdMentorId(mentorId: string | null, actorId: string): Promise<void> {
  await slot().set({ mentorId, updatedBy: actorId, updatedAt: new Date() });
}
