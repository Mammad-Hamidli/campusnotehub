import type { UserRecord } from '@/lib/firebase/repositories/users';
import type { MessageRecord } from '@/lib/firebase/repositories/messages';
import { visibleAvatar, type VisibilityViewer } from '@/lib/profile/visibility';

/** The other person in a conversation, as much as a chat header needs. Never the legal name. */
export type ChatPeer = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  isVerified: boolean;
};

export type ChatMessage = {
  id: string;
  body: string;
  createdAt: string;
  fromMe: boolean;
};

export function chatPeer(user: UserRecord, viewer: VisibilityViewer): ChatPeer {
  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: visibleAvatar(user, viewer),
    isVerified: user.isVerified,
  };
}

export function chatMessage(message: MessageRecord, viewerId: string): ChatMessage {
  return {
    id: message.id,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    fromMe: message.senderId === viewerId,
  };
}

/** Ids are path segments here: the same shape every other user-id route accepts. */
export const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Who may be messaged, or found to message: an account whose content may be
 * shown at all, that has a real handle (not a quick-login account still on
 * its temporary "user12345"), and that is not the viewer.
 */
export function isMessageable(user: UserRecord | null | undefined, viewerId: string): user is UserRecord {
  return Boolean(
    user &&
      user.id !== viewerId &&
      !user.deletedAt &&
      (user.accountStatus === 'ACTIVE' || user.accountStatus === 'RESTRICTED') &&
      user.profileIncomplete !== true,
  );
}
