import { NextResponse, type NextRequest } from 'next/server';
import { withAdmin } from '@/lib/auth/admin';
import { MAX_UPLOAD_BYTES } from '@/lib/media/constants';
import { processImage } from '@/lib/media/images';
import { avatarUrlFor, storeAvatar } from '@/lib/media/avatars';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Stored as a media asset and served from /api/media/:id, like every other
 * picture on the site. A Cloudinary URL would be blocked by `img-src 'self'`.
 */
export async function POST(request: NextRequest) {
  return withAdmin(request, 'MODERATOR', async (actor) => {
    let file: FormDataEntryValue | null;
    // `file` is the field uploadImage() (browser-upload.ts) sends.
    try { file = (await request.formData()).get('file'); } catch { return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 }); }
    if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
    if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: 'admin.announcements.errors.imageTooLarge' }, { status: 413 });
    const input = Buffer.from(await file.arrayBuffer());
    try {
      const result = await processImage(input);
      if (!result.ok) return NextResponse.json({ error: 'admin.announcements.errors.invalidImage' }, { status: 400 });
      const asset = await storeAvatar(actor.id, result.image);
      return NextResponse.json({ imageUrl: avatarUrlFor(asset.id) }, { headers: { 'Cache-Control': 'no-store' } });
    } finally {
      input.fill(0);
    }
  });
}
