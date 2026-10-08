import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { listBlocked } from '@/lib/firebase/repositories/messages';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { chatPeer } from '@/lib/messages/serialize';
import { visibilityRelationshipsFor } from '@/lib/profile/visibility.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/me/blocks - the people the viewer blocked from messaging them,
 * most recent first, so a block can be found and lifted
 * (DELETE /api/me/blocks/:userId). A blocked account that has since been
 * deleted is left out; its block row is harmless.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const rows = await listBlocked(auth.userId);
  const people = await findUsersByIds(rows.map((row) => row.blockedId));
  const relationships = await visibilityRelationshipsFor([...people.keys()], auth.viewer);
  const blocked = rows.flatMap((row) => {
    const user = people.get(row.blockedId);
    if (!user || user.deletedAt) return [];
    return [{ ...chatPeer(user, auth.viewer, relationships.get(user.id)), blockedAt: row.createdAt.toISOString() }];
  });

  return NextResponse.json({ blocked }, { headers: { 'Cache-Control': 'no-store' } });
}
