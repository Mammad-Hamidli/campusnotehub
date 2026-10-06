import { findMentorsByIds, type MentorProfileRecord } from '@/lib/firebase/repositories/mentors';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';
import { getFeedAdEntries, isLiveEntry } from '@/lib/firebase/repositories/feedAd';
import { isPubliclyVisible, visibleAvatar } from '@/lib/profile/visibility';

/** A promoted mentor as the feed's right rail shows it. */
export type FeedAd = {
  mentorId: string;
  nickname: string;
  avatarUrl: string | null;
  isVerified: boolean;
  university: string | null;
  headline: string;
  industry: string;
  jobTitle: string | null;
  company: string | null;
  ratingAvg: number;
  ratingCount: number;
  sessionsCompleted: number;
  hourlyRateMinor: number;
};

/**
 * Who may be in the ad slot: an approved profile whose account is publicly
 * visible. The one definition - applied when staff promote, to the admin
 * panel's candidate list, and again on every public read.
 */
export function isPromotable(
  mentor: Pick<MentorProfileRecord, 'isApproved'> | null | undefined,
  owner: Parameters<typeof isPubliclyVisible>[0],
): boolean {
  return mentor?.isApproved === true && isPubliclyVisible(owner);
}

export type FeedAdSlot = {
  ads: FeedAd[];
  /** A stored promotion has lapsed and is waiting for sweepExpiredFeedAds(). */
  lapsed: boolean;
  /** The soonest end among the live promotions, so a cache can stop serving one at its end. */
  nextExpiry: Date | null;
};

/**
 * The promoted mentors still eligible, in promotion order.
 *
 * Re-checked on every read rather than trusted from when staff promoted them:
 * a promotion whose duration has run out, a profile that has since been
 * unapproved, or an account that was suspended or deleted silently drops out.
 * The duration check is HERE, on the read path, so an ad stops at its end
 * whether or not the sweep that tidies the stored list has run yet. Three
 * batched reads however many are promoted. The response is shared by every
 * viewer (and cached by the CDN), so each avatar is the one a signed-out
 * visitor may see.
 */
export async function loadFeedAdSlot(now = new Date()): Promise<FeedAdSlot> {
  const entries = await getFeedAdEntries();
  const live = entries.filter((entry) => isLiveEntry(entry, now));
  const lapsed = live.length < entries.length;
  const nextExpiry = live.reduce<Date | null>(
    (soonest, { expiresAt }) => (expiresAt && (!soonest || expiresAt < soonest) ? expiresAt : soonest),
    null,
  );
  const ids = live.map((entry) => entry.mentorId);
  if (ids.length === 0) return { ads: [], lapsed, nextExpiry };

  const mentors = await findMentorsByIds(ids);
  const owners = await findUsersByIds([...mentors.values()].map((m) => m.userId));
  const universities = await findUniversitiesByIds(
    [...owners.values()].map((u) => u.universityId).filter((id): id is string => Boolean(id)),
  );

  const ads = ids.flatMap((id) => {
    const mentor = mentors.get(id);
    const user = mentor ? owners.get(mentor.userId) : undefined;
    if (!mentor || !user || !isPromotable(mentor, user)) return [];
    return [{
      mentorId: mentor.id,
      nickname: user.nickname,
      avatarUrl: visibleAvatar(user, null),
      isVerified: user.isVerified,
      university: (user.universityId && universities.get(user.universityId)?.code) || null,
      headline: mentor.headline,
      industry: mentor.industry,
      jobTitle: mentor.jobTitle,
      company: mentor.company,
      ratingAvg: Number(mentor.ratingAvg),
      ratingCount: mentor.ratingCount,
      sessionsCompleted: mentor.sessionsCompleted,
      hourlyRateMinor: mentor.hourlyRateMinor,
    }];
  });
  return { ads, lapsed, nextExpiry };
}

export async function loadFeedAds(now = new Date()): Promise<FeedAd[]> {
  return (await loadFeedAdSlot(now)).ads;
}
