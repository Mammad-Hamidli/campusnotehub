import type { NextRequest } from 'next/server';
import { cancelDeviceLink, getDeviceLinkStatus } from '@/lib/firebase/repositories/deviceLinks';
import { mfaJson, mfaSession } from '@/lib/auth/mfa-http';
import { describeUserAgent } from '@/lib/security/userAgent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ linkId: string }> };

/**
 * GET /api/me/device-links/:id - polled by the issuing browser while its QR
 * code is on screen: pending, linked (and by what), or expired.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  const status = await getDeviceLinkStatus(session.userId, (await params).linkId);
  if (!status) return mfaJson({ error: 'errors.notFound' }, 404);
  if (status.state === 'linked') {
    return mfaJson({ state: 'linked', device: describeUserAgent(status.userAgent), linkedAt: status.linkedAt.toISOString() });
  }
  return mfaJson(status.state === 'pending' ? { state: 'pending', expiresAt: status.expiresAt.toISOString() } : status);
}

/** DELETE /api/me/device-links/:id - withdraw a code nobody has scanned yet. */
export async function DELETE(request: NextRequest, { params }: Params) {
  const session = await mfaSession(request);
  if (session instanceof Response) return session;

  await cancelDeviceLink(session.userId, (await params).linkId);
  return mfaJson({ ok: true });
}
