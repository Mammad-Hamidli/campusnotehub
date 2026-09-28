import { NextResponse, type NextRequest } from 'next/server';
import { contactSchema, isHoneypotFilled } from '@/server/validators/contact';
import { clientIp, rateLimit } from '@/lib/security/ratelimit';
import { sendEmailAsync } from '@/lib/email/send';
import { contactInbox } from '@/lib/email/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Far above the largest valid body (the caps in the validator), far below abuse. */
const MAX_BODY_BYTES = 32 * 1024;

/**
 * POST /api/contact - the /contact form, delivered to the team's inbox
 * (CONTACT_INBOX, else the support mailbox) as the `contactMessage` email.
 *
 * Anonymous, so every defence is here:
 *  - a body-size cap before anything is parsed;
 *  - a honeypot field no person sees. A bot that fills it gets the same 200 a
 *    person would, so it learns nothing and has no reason to retry;
 *  - the zod schema's length caps and control-character stripping;
 *  - `contact:send`, a per-address limit charged only on VALID messages, so a
 *    person fixing a typo does not spend their quota.
 *
 * The send is sendEmailAsync(): the response does not wait for SMTP, and a
 * failed send is parked in the email outbox and retried, so "sent" means the
 * message is the platform's responsibility now. Reply-To is the visitor, so
 * the team answers with an ordinary reply.
 */
export async function POST(request: NextRequest) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'errors.validationFailed' }, { status: 413 });
  }

  const body = await request.json().catch(() => null);
  if (isHoneypotFilled(body)) return NextResponse.json({ ok: true });

  const parsed = contactSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'errors.validationFailed', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const rate = await rateLimit('contact:send', { ip: clientIp(request.headers) });
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'errors.rateLimited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const { name, email, subject, message, locale } = parsed.data;
  sendEmailAsync(
    contactInbox(),
    'contactMessage',
    { name, email, subject, message, locale: locale ?? null },
    { replyTo: email },
  );

  return NextResponse.json({ ok: true });
}
