import { findMentorById } from '@/lib/firebase/repositories/mentors';
import { findUserById } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';
import { getFeedAdMentorId } from '@/lib/firebase/repositories/feedAd';
import { isPubliclyVisible, visibleAvatar } from '@/lib/profile/visibility';

/** The promoted mentor as the feed's right rail shows it. */
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
 * The ad currently in the slot, or null.
 *
 * Re-checked on every read rather than trusted from when staff promoted it: a
 * profile that has since been unapproved, or whose account was suspended or
 * deleted, silently leaves the slot empty. The response is shared by every
 * viewer (and cached by the CDN), so the avatar is the one a signed-out
 * visitor may see.
 */
export async function loadFeedAd(): Promise<FeedAd | null> {
  const mentorId = await getFeedAdMentorId();
  const mentor = mentorId ? await findMentorById(mentorId) : null;
  if (!mentor?.isApproved) return null;

  const user = await findUserById(mentor.userId);
  if (!isPubliclyVisible(user)) return null;

  const university = user.universityId
    ? (await findUniversitiesByIds([user.universityId])).get(user.universityId)
    : null;

  return {
    mentorId: mentor.id,
    nickname: user.nickname,
    avatarUrl: visibleAvatar(user, null),
    isVerified: user.isVerified,
    university: university?.code ?? null,
    headline: mentor.headline,
    industry: mentor.industry,
    jobTitle: mentor.jobTitle,
    company: mentor.company,
    ratingAvg: Number(mentor.ratingAvg),
    ratingCount: mentor.ratingCount,
    sessionsCompleted: mentor.sessionsCompleted,
    hourlyRateMinor: mentor.hourlyRateMinor,
  };
}
