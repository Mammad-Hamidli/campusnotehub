import 'server-only';
import { AccountStatus, FieldVisibility, VerificationStatus } from '@/lib/enums';
import { findUserByNickname, profileCounts, type UserRecord } from '@/lib/firebase/repositories/users';
import { findUniversityById } from '@/lib/firebase/repositories/reference';
import { isFollowing } from '@/lib/firebase/repositories/follows';
import type { Viewer } from '@/lib/permissions';

/**
 * Someone else's profile, as a viewer is allowed to see it.
 *
 * ONE projection shared by the /u/[nickname] page (server-rendered, no API
 * hop) and GET /api/users/[nickname], so the two can never disagree about
 * what is public. It is an allow-list: email, phone, date of birth and every
 * internal field stay out, and the three fields with a privacy setting
 * (real name, university) honour it - PUBLIC to everyone, VERIFIED_ONLY to
 * verified viewers, PRIVATE to nobody but the owner.
 */
export type PublicProfile = {
  id: string;
  nickname: string;
  fullName: string | null;
  avatarUrl: string | null;
  headline: string | null;
  bio: string | null;
  role: string;
  isVerified: boolean;
  university: { code: string; name: string; city: string } | null;
  joinedAt: string;
  counts: { posts: number; notes: number; followers: number; following: number };
  viewer: { isSelf: boolean; isFollowing: boolean; canFollow: boolean };
};

function visibleTo(setting: string, viewer: Viewer | null, isSelf: boolean): boolean {
  if (isSelf || setting === FieldVisibility.PUBLIC) return true;
  if (setting === FieldVisibility.VERIFIED_ONLY) return viewer?.verificationStatus === VerificationStatus.VERIFIED;
  return false;
}

/** Accounts that must not have a public page: gone, banned, or still unnamed. */
function listable(user: UserRecord): boolean {
  return (
    !user.deletedAt &&
    user.accountStatus !== AccountStatus.BANNED &&
    user.accountStatus !== AccountStatus.DELETED &&
    user.profileIncomplete !== true
  );
}

export async function loadPublicProfile(
  nickname: string,
  viewer: Viewer | null,
  options: { canFollow: boolean; locale?: string } = { canFollow: false },
): Promise<PublicProfile | null> {
  const user = await findUserByNickname(nickname);
  if (!user || !listable(user)) return null;

  const isSelf = viewer?.id === user.id;
  const [university, counts, following] = await Promise.all([
    user.universityId && visibleTo(user.showUniversity, viewer, isSelf) ? findUniversityById(user.universityId) : null,
    profileCounts(user.id),
    viewer && !isSelf ? isFollowing(viewer.id, user.id) : false,
  ]);

  const name = (u: NonNullable<typeof university>) =>
    options.locale === 'en' ? u.nameEn : options.locale === 'ru' ? u.nameRu : u.nameAz;

  return {
    id: user.id,
    nickname: user.nickname,
    fullName: visibleTo(user.showRealName, viewer, isSelf) && user.fullName ? user.fullName : null,
    avatarUrl: user.avatarUrl,
    headline: user.headline,
    bio: user.bio,
    role: user.role,
    isVerified: user.isVerified,
    university: university ? { code: university.code, name: name(university), city: university.city } : null,
    joinedAt: user.createdAt.toISOString(),
    counts,
    viewer: { isSelf, isFollowing: following, canFollow: !isSelf && options.canFollow },
  };
}
