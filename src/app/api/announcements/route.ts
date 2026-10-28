import { NextResponse, type NextRequest } from 'next/server';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { adminDb } from '@/lib/firebase/admin';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { publicAnnouncement } from '@/lib/announcements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Return the newest announcement whose publishing window currently includes this viewer. */
export async function GET(request: NextRequest) {
  try {
    await requireSession(request, { passive: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ announcement: null }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    throw error;
  }

  const now = new Date().toISOString();
  const rows = await adminDb().collection(COLLECTIONS.announcements)
    .where('isActive', '==', true).limit(100).get();
  const announcements: (Record<string, unknown> & { id: string })[] = rows.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }));
  const current = announcements
    .filter((item) => (!item.startsAt || String(item.startsAt) <= now) && (!item.endsAt || String(item.endsAt) > now))
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];

  return NextResponse.json(
    { announcement: current ? publicAnnouncement(current) : null },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
