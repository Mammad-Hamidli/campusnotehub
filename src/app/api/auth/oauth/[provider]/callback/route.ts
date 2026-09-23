import { NextResponse, type NextRequest } from 'next/server';
import { handleCallback } from '@/lib/auth/oauth/callback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ provider: string }> };

/**
 * The redirect URI registered with Google. Google uses response_mode=query, so
 * the callback is a top-level GET and nothing else.
 *
 * POST is refused outright: nothing here uses form_post, and leaving the
 * method open would be a second, laxer entry point into the same state
 * machine.
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const { provider } = await params;
  return handleCallback(request, provider, request.nextUrl.searchParams);
}

export function POST() {
  return NextResponse.json({ error: 'errors.methodNotAllowed' }, { status: 405 });
}
