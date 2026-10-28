import { NextResponse, type NextRequest } from 'next/server';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { adminDb } from '@/lib/firebase/admin';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { announcementSchema } from '@/lib/announcements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async () => {
    const snap = await adminDb().collection(COLLECTIONS.announcements).limit(100).get();
    const announcements: (Record<string, unknown> & { id: string })[] = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const sorted = announcements
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return NextResponse.json({ announcements: sorted }, { headers: { 'Cache-Control': 'no-store' } });
  });
}

export async function POST(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const parsed = announcementSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
    const now = new Date().toISOString();
    const ref = adminDb().collection(COLLECTIONS.announcements).doc();
    const announcement = { ...parsed.data, createdAt: now, updatedAt: now, createdBy: actor.id };
    await ref.set(announcement);
    await adminAudit({ actorId: actor.id, action: 'ADMIN_ANNOUNCEMENT_CREATED', entityType: 'announcement', entityId: ref.id, after: announcement, request });
    return NextResponse.json({ announcement: { id: ref.id, ...announcement } }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  });
}
