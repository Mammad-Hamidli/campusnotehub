import { NextResponse, type NextRequest } from 'next/server';
import { withAdmin, adminAudit } from '@/lib/auth/admin';
import { adminDb } from '@/lib/firebase/admin';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { ANNOUNCEMENT_ID, announcementSchema } from '@/lib/announcements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ announcementId: string }> }) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const { announcementId } = await params;
    if (!ANNOUNCEMENT_ID.test(announcementId)) return notFound();
    const ref = adminDb().collection(COLLECTIONS.announcements).doc(announcementId);
    const existing = await ref.get();
    if (!existing.exists) return notFound();
    const parsed = announcementSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
    const before = existing.data() ?? {};
    const after = { ...parsed.data, updatedAt: new Date().toISOString() };
    await ref.update(after);
    await adminAudit({ actorId: actor.id, action: 'ADMIN_ANNOUNCEMENT_UPDATED', entityType: 'announcement', entityId: announcementId, before, after, request });
    return NextResponse.json({ announcement: { id: announcementId, ...after } }, { headers: { 'Cache-Control': 'no-store' } });
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ announcementId: string }> }) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    const { announcementId } = await params;
    if (!ANNOUNCEMENT_ID.test(announcementId)) return notFound();
    const ref = adminDb().collection(COLLECTIONS.announcements).doc(announcementId);
    const existing = await ref.get();
    if (!existing.exists) return notFound();
    await ref.delete();
    await adminAudit({ actorId: actor.id, action: 'ADMIN_ANNOUNCEMENT_DELETED', entityType: 'announcement', entityId: announcementId, before: existing.data(), request });
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
