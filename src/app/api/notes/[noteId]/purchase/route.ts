import { NextResponse, type NextRequest } from 'next/server';
import { findUserById } from '@/lib/firebase/repositories/users';
import { requireSession, UnauthorizedError } from '@/lib/auth/session';
import { can, denialKey } from '@/lib/permissions';
import { rateLimit, clientIp } from '@/lib/security/ratelimit';
import {
  AlreadyPurchasedError,
  InsufficientFundsError,
  NoteNotPurchasableError,
  SelfPurchaseError,
  purchaseNote,
} from '@/lib/wallet/ledger';
import { sendEmailAsync } from '@/lib/email/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/notes/:noteId/purchase
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE IS THIN
 * ---------------------------------------------------------------------------
 * All of the hard work already existed and is untouched: purchaseNote() in
 * src/lib/wallet/ledger.ts does the balance check under a row lock, writes the
 * double-entry posting, holds the seller's funds in escrow for
 * SELLER_CLEARING_HOURS, and schedules the release. What was missing was any
 * way to CALL it - there was no purchase endpoint anywhere in the codebase,
 * which is why "note purchased" and "note sold" emails had no event to fire
 * from.
 *
 * So this handler is authorization, rate limiting, error mapping and the two
 * emails. It deliberately does not re-implement any money logic.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * This spends an EXISTING wallet balance. It is not a payment-provider
 * integration: no card is charged here, and topping a wallet up is a separate
 * flow (PAYMENT_PROVIDER / PAYMENT_WEBHOOK_SECRET in the environment) that
 * does not exist yet. A note priced at zero is therefore purchasable by
 * anyone, and a priced note requires funds that currently only arrive by an
 * operator crediting the wallet.
 */
/**
 * THE RETRY WRAPPER IS GONE, AND ITS JOB IS NOW THE DATABASE'S.
 *
 * This route used to re-run purchaseNote() up to three times on Prisma's
 * P2028 - "could not start a transaction within the window" - which happened
 * under a brief connection-pool squeeze and surfaced as a 500 on a payment
 * endpoint, the worst possible place for a transient error to be fatal.
 *
 * Firestore has no connection pool and no transaction-start timeout, and it
 * retries a contended transaction internally before giving up. The condition
 * being recovered from does not exist any more, so hand-rolling a retry on top
 * would add a second retry loop around one that already works - and every
 * error that CAN reach the catch below is now a real answer that must be
 * returned rather than attempted again.
 *
 * The idempotency that made retrying safe is unchanged and still load-bearing:
 * the order document id is derived from (buyer, note), so a second execution
 * collides instead of charging twice.
 */

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ noteId: string }> },
) {
  const { noteId } = await params;

  let userId: string;
  let viewer;
  try {
    ({ userId, viewer } = await requireSession(request));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'errors.sessionExpired' }, { status: 401 });
    }
    throw error;
  }

  /**
   * `notes:buy` requires a VERIFIED identity (see REQUIRES_VERIFICATION in
   * src/lib/permissions.ts). denialKey() tells an unverified buyer that
   * verification is the fix; a frozen account gets the generic refusal.
   */
  if (!can(viewer, 'notes:buy')) {
    return NextResponse.json({ error: denialKey(viewer, 'notes:buy') }, { status: 403 });
  }

  const rate = await rateLimit('orders:create', { userId, ip: clientIp(request.headers) });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  /**
   * The idempotency key is derived, not client-supplied.
   *
   * `order:<buyer>:<note>` is stable across retries, and Order.idempotencyKey
   * is unique - so a double-submitted form or a retried request after a
   * timeout hits the constraint instead of charging the buyer twice. Letting
   * the client choose the key would let it opt OUT of that protection simply
   * by sending a fresh value.
   */
  const idempotencyKey = `order:${userId}:${noteId}`;

  try {
    const { order, note } = await purchaseNote({ buyerId: userId, noteId, idempotencyKey });

    /**
     * Both emails, after the transaction has committed.
     *
     * Never inside it: a mail send is a network call, and holding a money
     * transaction open across one is how a payment ends up waiting on an SMTP
     * handshake. sendEmailAsync never throws, so a provider outage cannot
     * unwind a completed purchase.
     */
    const money = (minor: number) =>
      new Intl.NumberFormat('en', { style: 'currency', currency: note.currency || 'AZN' }).format(
        minor / 100,
      );

    const buyer = await findUserById(userId);

    if (buyer) {
      sendEmailAsync(buyer.email, 'notePurchased', {
        nickname: buyer.nickname,
        title: note.title,
        priceLabel: money(order.priceMinor),
      });
    }

    sendEmailAsync(note.seller.email, 'noteSold', {
      nickname: note.seller.nickname,
      title: note.title,
      // The seller's NET, not the sticker price - telling them they earned the
      // gross and then paying less is the fastest way to a support ticket.
      earnedLabel: money(order.sellerNetMinor),
    });

    return NextResponse.json(
      {
        order: {
          id: order.id,
          noteId: order.noteId,
          status: order.status,
          priceMinor: order.priceMinor,
          currency: order.currency,
          paidAt: order.paidAt,
        },
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    // Every one of these is the caller's situation, not a server fault, and
    // each gets a locale key the UI can render.
    if (error instanceof InsufficientFundsError) {
      // 402 is the accurate code and is used deliberately: the request was
      // well-formed and authorized, it simply cannot be paid for.
      return NextResponse.json({ error: error.messageKey }, { status: 402 });
    }
    if (error instanceof AlreadyPurchasedError) {
      return NextResponse.json({ error: error.messageKey }, { status: 409 });
    }
    if (error instanceof SelfPurchaseError || error instanceof NoteNotPurchasableError) {
      return NextResponse.json({ error: error.messageKey }, { status: 400 });
    }
    /**
     * ALREADY_EXISTS from the order `create()`.
     *
     * This is the successor to Prisma's P2002: a concurrent duplicate purchase
     * lost the race for the derived order id. It is the idempotency guarantee
     * working rather than an error, so it answers 409 "you already own this"
     * and never charges anyone.
     */
    if ((error as { code?: number }).code === 6) {
      return NextResponse.json({ error: 'notes.errors.alreadyOwned' }, { status: 409 });
    }

    // Anything else is genuinely ours. Logged, never echoed - a money path's
    // internals are not something to hand back to a caller.
    console.error(`[purchase] unhandled error on note ${noteId}`, error);
    return NextResponse.json({ error: 'errors.generic' }, { status: 500 });
  }
}
