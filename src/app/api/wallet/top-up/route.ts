import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can, denialKey } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import { ensureWallet } from '@/lib/firebase/repositories/wallets';
import { findUserById } from '@/lib/firebase/repositories/users';
import { writeAuditLog } from '@/lib/firebase/repositories/audit';
import { enqueueNotification } from '@/lib/notifications/dispatch';
import { sendEmailAsync } from '@/lib/email/send';
import {
  MAX_TOPUP_MINOR,
  MIN_TOPUP_MINOR,
  PaymentDeclinedError,
  WalletFrozenError,
  WalletMissingError,
  topUpWallet,
} from '@/lib/wallet/topup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const topUpSchema = z.object({
  amountMinor: z.coerce.number().int().min(MIN_TOPUP_MINOR).max(MAX_TOPUP_MINOR),
  // Client-generated per attempt; a retry of the same attempt reuses it.
  idempotencyKey: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
});

const azn = (minor: number) => `${(minor / 100).toFixed(2)} AZN`;

/**
 * POST /api/wallet/top-up   { amountMinor, idempotencyKey }
 *
 * Adds balance. The payment capture is a placeholder (see capturePayment in
 * src/lib/wallet/topup.ts); the ledger posting, balance, history and emails
 * are real.
 */
export async function POST(request: NextRequest) {
  let session;
  try {
    session = await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }
  const { userId, viewer } = session;

  if (!can(viewer, 'wallet:topup')) {
    return NextResponse.json({ error: denialKey(viewer, 'wallet:topup') }, { status: 403 });
  }

  const limit = await rateLimit('orders:create', { userId, ip: clientIp(request.headers) });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const parsed = topUpSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'wallet.topUpForm.errors.amount', min: MIN_TOPUP_MINOR, max: MAX_TOPUP_MINOR },
      { status: 400 },
    );
  }

  // Every account gets a wallet at registration; this heals one that did not.
  await ensureWallet(userId);

  let result;
  try {
    result = await topUpWallet({ userId, ...parsed.data });
  } catch (error) {
    if (error instanceof WalletFrozenError) {
      return NextResponse.json({ error: 'wallet.frozen' }, { status: 409 });
    }
    if (error instanceof PaymentDeclinedError) {
      return NextResponse.json({ error: 'wallet.topUpForm.errors.declined' }, { status: 402 });
    }
    if (error instanceof WalletMissingError) {
      return NextResponse.json({ error: 'errors.generic' }, { status: 500 });
    }
    throw error;
  }

  if (!result.replayed) {
    await writeAuditLog({
      actorId: userId,
      action: 'WALLET_TOPUP',
      entityType: 'wallet',
      entityId: userId,
      after: { amountMinor: parsed.data.amountMinor, txnId: result.txnId },
      userAgent: request.headers.get('user-agent')?.slice(0, 512),
    });

    await enqueueNotification({
      userId,
      type: 'WALLET_CREDIT',
      titleKey: 'notifications.wallet.topUpTitle',
      bodyKey: 'notifications.wallet.topUpBody',
      params: { amount: azn(parsed.data.amountMinor) },
      linkUrl: '/wallet',
    });

    const user = await findUserById(userId);
    if (user) {
      sendEmailAsync(
        user.email,
        'balanceToppedUp',
        {
          nickname: user.nickname,
          amountLabel: azn(parsed.data.amountMinor),
          balanceLabel: azn(result.availableMinor),
        },
        { dedupeKey: `topup:${result.txnId}` },
      );
    }
  }

  return NextResponse.json(
    { ok: true, txnId: result.txnId, availableMinor: result.availableMinor, replayed: result.replayed },
    { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
