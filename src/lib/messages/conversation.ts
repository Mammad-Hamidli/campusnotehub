import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

/**
 * Conversation helpers.
 *
 * The interesting decision here is `pairKey` - see the model comment in
 * schema.prisma. Everything in this file exists to keep that key's invariant
 * ("one thread per pair, whoever starts it") enforced by the DATABASE rather
 * than by a lucky ordering of application reads.
 */

/**
 * The canonical key for a pair of participants.
 *
 * Sorted, so it is identical whichever side opens the thread. Without the
 * sort, "a:b" and "b:a" would be two different keys and the UNIQUE constraint
 * would protect nothing - two people pressing Message simultaneously would get
 * two threads and each would see half the conversation.
 */
export function pairKeyFor(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Finds or creates the thread between two users.
 *
 * The create is wrapped in a P2002 catch rather than guarded by a preceding
 * findFirst, because a findFirst-then-create is a read-then-write race: both
 * requests read "no thread", both create, and one crashes while the other
 * leaves a duplicate. Letting the unique index decide and reading the winner's
 * row on conflict is the version that is correct under concurrency.
 */
export async function openConversation(userA: string, userB: string): Promise<string> {
  const pairKey = pairKeyFor(userA, userB);

  const existing = await db.conversation.findUnique({
    where: { pairKey },
    select: { id: true },
  });
  if (existing) return existing.id;

  try {
    const created = await db.conversation.create({
      data: {
        pairKey,
        members: { createMany: { data: [{ userId: userA }, { userId: userB }] } },
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Lost the race. The winner's row is the right answer.
      const winner = await db.conversation.findUniqueOrThrow({
        where: { pairKey },
        select: { id: true },
      });
      return winner.id;
    }
    throw error;
  }
}

/**
 * Confirms the caller is in the conversation, returning their membership.
 *
 * Returns null for both "no such conversation" and "not a member", so an
 * outsider cannot distinguish a thread that exists from one that does not by
 * comparing status codes. Every message route calls this first.
 */
export async function requireMembership(conversationId: string, userId: string) {
  return db.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { conversationId: true, userId: true, lastReadAt: true, archivedAt: true },
  });
}

/**
 * Who the OTHER participant is.
 *
 * Threads are strictly two-party, so this is well defined. Selected as a
 * narrow allow-list: the inbox shows a public handle and an avatar, and has no
 * business carrying an email or a legal name to the client.
 */
export const OTHER_MEMBER_SELECT = {
  user: {
    select: {
      id: true,
      nickname: true,
      avatarUrl: true,
      isVerified: true,
      headline: true,
      university: { select: { code: true } },
    },
  },
} satisfies Prisma.ConversationMemberSelect;
