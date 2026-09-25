import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { editHashtagTemplates, MAX_HASHTAG_TEMPLATES } from '@/lib/firebase/repositories/users';
import { TAG_PATTERN } from '@/lib/feed/hashtags';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST   /api/me/hashtag-templates { tag } - save a composer quick-tag
 * DELETE /api/me/hashtag-templates { tag } - remove it
 *
 * Both answer with the stored list, so the composer renders what persisted.
 * The list itself arrives with GET /api/me (hashtagTemplates).
 */
const bodySchema = z.object({
  tag: z
    .string()
    .trim()
    .transform((tag) => tag.replace(/^#/, ''))
    .pipe(z.string().regex(TAG_PATTERN)),
});

async function handle(request: NextRequest, op: 'add' | 'remove') {
  let userId: string;
  try {
    ({ userId } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  const rate = await rateLimit('profile:templates', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'feed.templates.errors.invalid' }, { status: 400 });

  const result = await editHashtagTemplates(userId, parsed.data.tag, op);
  if (result === 'full') {
    return NextResponse.json(
      { error: 'feed.templates.errors.full', params: { max: MAX_HASHTAG_TEMPLATES } },
      { status: 409 },
    );
  }
  return NextResponse.json({ templates: result }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  return handle(request, 'add');
}

export async function DELETE(request: NextRequest) {
  return handle(request, 'remove');
}
