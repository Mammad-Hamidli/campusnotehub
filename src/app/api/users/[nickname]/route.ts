import { NextResponse, type NextRequest } from 'next/server';
import { getViewer } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { loadPublicProfile } from '@/lib/profile/public';
import { usernameKey } from '@/lib/auth/username';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/users/:nickname - someone's public profile.
 *
 * Readable signed out (like the feed); the projection in
 * src/lib/profile/public.ts decides what each viewer may see.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ nickname: string }> }) {
  const { nickname } = await params;
  const key = usernameKey(decodeURIComponent(nickname));
  if (!key) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  const viewer = await getViewer();
  const rate = await rateLimit('search', { userId: viewer?.id, ip: clientIp(request.headers) });
  if (!rate.ok) return NextResponse.json({ error: 'errors.rateLimited' }, { status: 429 });

  const profile = await loadPublicProfile(key, viewer, { canFollow: can(viewer, 'users:follow') });
  if (!profile) return NextResponse.json({ error: 'errors.notFound' }, { status: 404 });

  return NextResponse.json({ profile }, { headers: { 'Cache-Control': 'no-store' } });
}
