import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { reauthenticate, reauthRequirement } from '@/lib/auth/reauth';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { buildAccountExport } from '@/lib/account/export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/me/export - "Download my data" (Settings -> Account).
 *
 *   GET   which proof the form should ask for: { reauth }
 *   POST  { password? | code? | recoveryCode? } -> the export, as a JSON file
 *
 * POST rather than GET because it takes a proof of identity in the body, and
 * a GET would put the file one link away from any page that can make the
 * browser follow one. The file is everything src/lib/account/export.ts
 * gathers: email, phone, date of birth, every post and message. A session
 * cookie proves a browser is signed in, not that its owner is at it, so the
 * account's strongest factor is asked for again - the same rule as filing a
 * deletion request.
 */

async function session(request: NextRequest) {
  try {
    return await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

export async function GET(request: NextRequest) {
  const auth = await session(request);
  if (!auth) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });

  return NextResponse.json(
    { reauth: await reauthRequirement(auth.userId) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

const exportSchema = z.object({
  password: z.string().min(1).max(200).optional(),
  code: z.string().trim().max(16).optional(),
  recoveryCode: z.string().trim().max(32).optional(),
});

export async function POST(request: NextRequest) {
  const auth = await session(request);
  if (!auth) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
  const { userId } = auth;

  // Before the proof is checked: this endpoint verifies a password, so it
  // must not become an unmetered guessing oracle for a stolen session.
  const limit = await rateLimit('account:export', { userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const parsed = exportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 400 });
  }

  const proof = await reauthenticate(request, auth, parsed.data);
  if (proof instanceof Response) return proof;

  const data = await buildAccountExport(userId);
  if (!data) return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });

  await writeAuditLog({
    actorId: userId,
    action: 'ACCOUNT_DATA_EXPORTED',
    entityType: 'user',
    entityId: userId,
    userAgent: request.headers.get('user-agent')?.slice(0, 512),
    after: { method: proof.method, truncated: data.truncated },
  });

  const handle = data.account.nickname.replace(/[^A-Za-z0-9_.-]/g, '_');
  const day = data.generatedAt.toISOString().slice(0, 10);

  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="campusnotehub-${handle}-${day}.json"`,
      // Personal data: never kept by the browser cache or anything between.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
