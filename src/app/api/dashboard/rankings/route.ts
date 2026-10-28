import { NextResponse, type NextRequest } from 'next/server';
import { NoteStatus, UserRole } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { findUsersByIds } from '@/lib/firebase/repositories/users';
import { listUniversities } from '@/lib/firebase/repositories/reference';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The same for every viewer and expensive to build (one count per university
 * plus up to 20k note reads), so each instance rebuilds it at most every ten
 * minutes instead of on every dashboard load.
 */
const TTL_MS = 10 * 60 * 1000;
let cached: { at: number; body: Promise<Rankings> } | null = null;

type Rankings = Awaited<ReturnType<typeof buildRankings>>;

/** Dashboard community rankings, based on active students and published notes. */
export async function GET(request: NextRequest) {
  try {
    await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    throw error;
  }

  if (!cached || Date.now() - cached.at > TTL_MS) {
    const body = buildRankings();
    cached = { at: Date.now(), body };
    // A failed build must not be served for the next ten minutes.
    body.catch(() => { if (cached?.body === body) cached = null; });
  }
  return NextResponse.json(await cached.body, { headers: { 'Cache-Control': 'private, no-store' } });
}

async function buildRankings() {
  const universities = await listUniversities();
  const db = adminDb();
  const universityCounts = await Promise.all(universities.map(async (university) => {
    const count = await db.collection(COLLECTIONS.users)
      .where('universityId', '==', university.id)
      .where('role', '==', UserRole.STUDENT)
      .where('accountStatus', '==', 'ACTIVE')
      .count().get();
    return {
      code: university.code,
      nameAz: university.nameAz,
      nameEn: university.nameEn,
      nameRu: university.nameRu,
      count: count.data().count,
    };
  }));

  // Notes have no materialised creator counter yet. Count published records in
  // one bounded read; the cap keeps this dashboard request predictable.
  const noteRows = await db.collection(COLLECTIONS.notes)
    .where('status', '==', NoteStatus.PUBLISHED)
    .limit(20000)
    .get();
  const noteCounts = new Map<string, number>();
  for (const row of noteRows.docs) {
    const sellerId = row.get('sellerId');
    if (typeof sellerId === 'string') noteCounts.set(sellerId, (noteCounts.get(sellerId) ?? 0) + 1);
  }
  const topIds = [...noteCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 50);
  const topUsers = await findUsersByIds(topIds.map(([id]) => id));
  const users = topIds.flatMap(([id, count]) => {
    const user = topUsers.get(id);
    return user && !user.deletedAt && user.accountStatus === 'ACTIVE'
      ? [{ id, nickname: user.nickname, count }]
      : [];
  }).slice(0, 5);

  return {
    universities: universityCounts.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, 10),
    topNoteSharers: users,
  };
}
