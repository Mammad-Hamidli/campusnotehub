import { NextResponse, type NextRequest } from 'next/server';
import { NotificationType } from '@/lib/enums';
import { z } from 'zod';
import { getViewer, requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can, ForbiddenError } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { toPlainText } from '@/lib/security/plainText';
import { findVisiblePost } from '@/lib/feed/visibility';
import {
  createComment,
  findCommentById,
  listComments,
  type CommentRecord,
} from '@/lib/firebase/repositories/posts';
import { findUserById, findUsersByIds } from '@/lib/firebase/repositories/users';
import { createNotification } from '@/lib/firebase/repositories/notifications';

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
  body: z
    .string()
    .max(2000)
    .transform(toPlainText)
    .pipe(z.string().min(1, 'errors.validationFailed').max(1000)),
  /** Optional parent for a one-level reply. */
  parentId: z.string().min(1).max(64).optional(),
});

/**
 * The author fields a comment renders.
 *
 * This replaced a Prisma `select`, which did double duty as "what to fetch"
 * and "what to return". Firestore returns whole documents, so the narrowing
 * has to happen here - and it is a narrowing that matters: the author's email,
 * phone and legal name are on the same record and none of them belongs in a
 * comment thread.
 */
type CommentAuthor = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  isVerified: boolean;
  headline: string | null;
};

function serialize(row: CommentRecord, author: CommentAuthor | null) {
  return {
    id: row.id,
    // A deleted comment keeps its row so replies beneath it do not vanish, but
    // its text is replaced rather than sent and hidden on the client - the
    // body must not travel to a browser that is only asked not to draw it.
    body: row.isDeleted ? '' : row.body,
    isDeleted: row.isDeleted,
    createdAt: row.createdAt.toISOString(),
    parentId: row.parentId,
    author: author ?? {
      // Firestore has no foreign keys, so an author document can genuinely be
      // absent. The contract stays "author is always an object".
      id: row.authorId,
      nickname: 'unknown',
      avatarUrl: null,
      isVerified: false,
      headline: null,
    },
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

  const [cursorTime] = cursor ? cursor.split('_') : [];

  // Ascending: a conversation reads oldest first, which is also the order the
  // (postId, createdAt) composite index provides.
  const rows = await listComments(postId, limit + 1, cursorTime ? new Date(cursorTime) : null);

  /**
   * The authors, in one batched read.
   *
   * This is what replaced the `author` join. Collecting the ids and fetching
   * them in batches of 30 is a fixed handful of round trips per page rather
   * than one per comment.
   */
  const authors = await findUsersByIds(rows.map((c) => c.authorId));

  /**
   * Content from banned accounts disappears without a separate cleanup job,
   * matching how the feed listing treats posts. Applied after the read because
   * Firestore cannot filter one collection by a field on another.
   */
  const visible = rows.filter((row) => {
    const author = authors.get(row.authorId);
    return Boolean(
      author &&
        !author.deletedAt &&
        (author.accountStatus === 'ACTIVE' || author.accountStatus === 'RESTRICTED'),
    );
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? visible.slice(0, limit) : visible;
  // Derived from the last row SCANNED, not the last shown: a page whose
  // comments were all filtered out would otherwise loop on the same cursor.
  const lastScanned = (hasMore ? rows.slice(0, limit) : rows).at(-1);

  return NextResponse.json(
    {
      comments: page.map((row) => {
        const author = authors.get(row.authorId);
        return serialize(
          row,
          author
            ? {
                id: author.id,
                nickname: author.nickname,
                avatarUrl: author.avatarUrl,
                isVerified: author.isVerified,
                headline: author.headline,
              }
            : null,
        );
      }),
      nextCursor:
        hasMore && lastScanned
          ? `${lastScanned.createdAt.toISOString()}_${lastScanned.id}`
          : null,
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
    const parent = await findCommentById(parsed.data.parentId);
    // The postId check is the important half and is done explicitly here:
    // Firestore fetches by id alone, so without it a caller could graft a
    // reply from one conversation onto another.
    if (!parent || parent.postId !== postId || parent.isDeleted) {
      return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });
    }
    // Flatten: a reply to a reply attaches to the same top-level parent.
    parentId = parent.parentId ?? parent.id;
  }

  /**
   * The comment and the post's counter are written in ONE BATCH.
   *
   * The denormalised `commentCount` is what the feed card renders, so it must
   * not be able to drift from the rows it describes - incrementing it in a
   * second request leaves the count permanently low whenever that request
   * fails. A Firestore batch commits atomically, which preserves exactly the
   * guarantee the SQL transaction gave. See createComment().
   */
  const comment = await createComment({ postId, authorId: userId, parentId, body: parsed.data.body });

  const author = await findUserById(userId);

  /**
   * Notify the post's author, unless they are commenting on themselves.
   *
   * Written directly rather than through enqueueNotification(): that helper
   * also pushes onto a BullMQ queue, and a Redis outage would then fail a
   * comment the user had already written. The in-app row is the part that must
   * be durable; fan-out is best-effort. It is written after the comment for the
   * same reason - a notification for a comment that does not exist would be a
   * lie, while a comment without its bell is merely a missed ping.
   */
  if (post.authorId !== userId) {
    await createNotification({
      userId: post.authorId,
      type: NotificationType.POST_REPLY,
      titleKey: 'notifications.postReply.title',
      bodyKey: 'notifications.postReply.body',
      params: { nickname: author?.nickname ?? '' },
      linkUrl: `/dashboard?post=${postId}`,
    });
  }

  return NextResponse.json(
    {
      comment: serialize(
        comment,
        author
          ? {
              id: author.id,
              nickname: author.nickname,
              avatarUrl: author.avatarUrl,
              isVerified: author.isVerified,
              headline: author.headline,
            }
          : null,
      ),
      commentCount: post.commentCount + 1,
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
