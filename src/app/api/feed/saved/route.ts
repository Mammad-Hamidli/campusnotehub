import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { findPostsByIds, listSavedPostIds, likedPostIds } from '@/lib/firebase/repositories/posts';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { findUniversitiesByIds } from '@/lib/firebase/repositories/reference';
import { serializePost } from '@/lib/feed/serialize';
import { resolveViewerAudience } from '@/lib/feed/visibility';
import { visibilityRelationshipsFor } from '@/lib/profile/visibility.server';
import { isPubliclyVisible } from '@/lib/profile/visibility';

export const dynamic = 'force-dynamic';

/** GET /api/feed/saved - the viewer's newest saved, still-visible posts. */
export async function GET(request: NextRequest) {
  let viewer;
  try {
    ({ viewer } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    throw error;
  }
  const ids = await listSavedPostIds(viewer.id);
  const byId = new Map((await findPostsByIds(ids)).map((post) => [post.id, post]));
  const audience = await resolveViewerAudience(viewer);
  const rows = ids.map((id) => byId.get(id)).filter((post) =>
    post && !post.isDeleted && post.audience?.some((token) => audience.tokens.includes(token)),
  );
  const authors = await findUsersByIds(rows.map((post) => post!.authorId));
  const visible = rows.filter((post) => isPubliclyVisible(authors.get(post!.authorId)));
  const [universities, liked, relationships] = await Promise.all([
    findUniversitiesByIds([...authors.values()].map((author) => author.universityId).filter((id): id is string => Boolean(id))),
    likedPostIds(visible.map((post) => post!.id), viewer.id),
    visibilityRelationshipsFor([...authors.keys()], viewer),
  ]);
  return NextResponse.json({ posts: visible.map((post) => {
    const author = authors.get(post!.authorId) ?? null;
    return serializePost(post!, {
      author,
      university: author?.universityId ? universities.get(author.universityId) ?? null : null,
      viewerId: viewer.id,
      viewer,
      relationship: author ? relationships.get(author.id) : undefined,
      likedByViewer: liked.has(post!.id),
      savedByViewer: true,
    });
  }) }, { headers: { 'Cache-Control': 'private, no-store' } });
}
