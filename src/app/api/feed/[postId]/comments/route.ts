import { NextResponse, type NextRequest } from 'next/server';
import { NotificationType } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getViewer, requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can, ForbiddenError } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { findVisiblePost } from '@/lib/feed/visibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Comments on a post.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS NEW
 * ---------------------------------------------------------------------------
 * "Comments cannot be written after a post is created" had a simple cause:
 * there was no comment endpoint anywhere in the codebase. The Comment model
 * existed in the schema, the feed card rendered a comment button with a count,
 * and nothing was ever wired between them - the button had no click handler at
 * all. So the failure was not a broken request, it was the absence of one.
 *
 * Both handlers resolve the post through findVisiblePost(), which applies the
 * same visibility rule the feed listing uses. Commenting on a post you could
 * never have read would otherwise be possible by guessing an id, and the
 * resulting comment would appear to its author out of nowhere.
 */

const MAX_DEPTH_NOTE = `Replies are one level deep: a reply targets a top-level
comment, and a reply to a reply attaches to the same parent. Arbitrary nesting
turns the thread into a tree nobody can read on a phone, and it is the usual
source of unbounded recursive queries.`;
void MAX_DEPTH_NOTE;

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

const createSchema = z.object({
  body: z.string().trim().min(1, 'errors.validationFailed').max(1000),
  /** Optional parent for a one-level reply. */
  parentId: z.string().cuid().optional(),
});

/** Shape returned for one comment. Kept in one place so both routes agree. */
const COMMENT_SELECT = {
  id: true,
  body: true,
  createdAt: true,
  parentId: true,
  isDeleted: true,
  author: {
    select: { id: true, nickname: true, avatarUrl: true, isVerified: true, headline: true },
  },
} as const;

type CommentRow = {
  id: string;
  body: string;
  createdAt: Date;
  parentId: string | null;
  isDeleted: boolean;
  author: {
    id: string;
    nickname: string;
    avatarUrl: string | null;
    isVerified: boolean;
    headline: string | null;
  };
};

function serialize(row: CommentRow) {
  return {
    id: row.id,
    // A deleted comment keeps its row so replies beneath it do not vanish, but
    // its text is replaced rather than sent and hidden on the client - the
    // body must not travel to a browser that is only asked not to draw it.
    body: row.isDeleted ? '' : row.body,
    isDeleted: row.isDeleted,
    createdAt: row.createdAt.toISOString(),
    parentId: row.parentId,
    author: row.author,
  };
}

/**
 * GET /api/feed/:postId/comments
 *
 * Readable by anyone who can read the post, including signed-out visitors on a
 * PUBLIC post - the feed itself is readable signed out, and a comment list
 * that required a session would be inconsistent with it.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;
  const viewer = await getViewer();

  const parsed = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }
  const { limit, cursor } = parsed.data;

  const post = await findVisiblePost(postId, viewer);
  if (!post) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  const [cursorTime, cursorId] = cursor ? cursor.split('_') : [];

  const rows = await db.comment.findMany({
    where: {
      postId,
      // Content from banned accounts disappears without a separate cleanup
      // job, matching how the feed listing treats posts.
      author: { accountStatus: { in: ['ACTIVE', 'RESTRICTED'] } },
      ...(cursorTime && cursorId
        ? {
            OR: [
              { createdAt: { gt: new Date(cursorTime) } },
              { createdAt: new Date(cursorTime), id: { gt: cursorId } },
            ],
          }
        : {}),
    },
    // Ascending: a conversation reads oldest first, which is also the order
    // the (postId, createdAt) index already provides.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    select: COMMENT_SELECT,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return NextResponse.json(
    {
      comments: page.map(serialize),
      nextCursor: hasMore && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * POST /api/feed/:postId/comments
 *
 * Requires a session and the `feed:comment` capability, which is what excludes
 * frozen and banned accounts - the capability table in src/lib/permissions.ts
 * is the authority, not a status check written out again here.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  const { postId } = await params;

  let userId: string;
  let viewer;
  try {
    ({ userId, viewer } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  if (!can(viewer, 'feed:comment')) {
    return NextResponse.json({ error: new ForbiddenError('feed:comment').messageKey }, { status: 403 });
  }

  const rate = await rateLimit('feed:comment', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const post = await findVisiblePost(postId, viewer);
  if (!post) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  /**
   * A parent must belong to THIS post.
   *
   * Without the postId in this lookup, a caller could pass any comment id and
   * graft a reply from one conversation onto another - the reply would render
   * under a post whose author never saw the thread it came from.
   */
  let parentId: string | null = null;
  if (parsed.data.parentId) {
    const parent = await db.comment.findFirst({
      where: { id: parsed.data.parentId, postId, isDeleted: false },
      select: { id: true, parentId: true, authorId: true },
    });
    if (!parent) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }
    // Flatten: a reply to a reply attaches to the same top-level parent.
    parentId = parent.parentId ?? parent.id;
  }

  const comment = await db.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: { postId, authorId: userId, parentId, body: parsed.data.body },
      select: COMMENT_SELECT,
    });

    // The denormalised counter on the post is what the feed card renders, so
    // it is incremented in the SAME transaction. Doing it afterwards leaves
    // the count permanently low whenever the second write fails.
    await tx.post.update({
      where: { id: postId },
      data: { commentCount: { increment: 1 } },
    });

    /**
     * Notify the post's author, unless they are commenting on themselves.
     *
     * Written directly rather than through enqueueNotification(): that helper
     * also pushes onto a BullMQ queue, and a Redis outage would then roll this
     * transaction back and lose a comment the user had already written. The
     * in-app row is the part that must be durable; fan-out is best-effort.
     */
    if (post.authorId !== userId) {
      await tx.notification.create({
        data: {
          userId: post.authorId,
          type: NotificationType.POST_REPLY,
          titleKey: 'notifications.postReply.title',
          bodyKey: 'notifications.postReply.body',
          params: { nickname: created.author.nickname },
          linkUrl: `/dashboard?post=${postId}`,
        },
      });
    }

    return created;
  });

  return NextResponse.json(
    { comment: serialize(comment), commentCount: post.commentCount + 1 },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
