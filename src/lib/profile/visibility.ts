import { FieldVisibility, VerificationStatus } from '@/lib/enums';

/**
 * The per-field privacy rule, in one place for every surface that shows a
 * person: PUBLIC to everyone, VERIFIED_ONLY to verified viewers, PRIVATE to
 * nobody but the owner. An unknown or absent setting reads as PUBLIC only
 * for the avatar (see visibleAvatar); callers pass the stored value.
 */
export type VisibilityViewer = { id: string; verificationStatus: string } | null | undefined;

/**
 * Whether an account's content may be shown at all: not deleted, and not
 * suspended or banned. Firestore cannot filter one collection by a field of
 * another, so every listing (feed, comments, mentors, the feed ad) applies
 * this after loading the authors - and this is the one definition of it.
 */
export function isPubliclyVisible(
  user: { deletedAt?: Date | null; accountStatus: string } | null | undefined,
): user is NonNullable<typeof user> {
  return Boolean(user && !user.deletedAt && (user.accountStatus === 'ACTIVE' || user.accountStatus === 'RESTRICTED'));
}

export function visibleTo(setting: string, viewer: VisibilityViewer, isSelf: boolean): boolean {
  if (isSelf || setting === FieldVisibility.PUBLIC) return true;
  if (setting === FieldVisibility.VERIFIED_ONLY) return viewer?.verificationStatus === VerificationStatus.VERIFIED;
  return false;
}

/**
 * The avatar URL this viewer may see, or null. The URL is an unguessable
 * media id (see /api/media/[mediaId]), so withholding it IS the protection -
 * the same model post images use. Accounts that predate the setting are
 * PUBLIC, which is what they were before it existed.
 */
export function visibleAvatar(
  user: { id: string; avatarUrl: string | null; showAvatar?: string },
  viewer: VisibilityViewer,
): string | null {
  if (!user.avatarUrl) return null;
  return visibleTo(user.showAvatar ?? FieldVisibility.PUBLIC, viewer, viewer?.id === user.id) ? user.avatarUrl : null;
}
