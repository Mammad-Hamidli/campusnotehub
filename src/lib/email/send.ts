import { createHash } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { after } from 'next/server';
import { Resend } from 'resend';
import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { buildEmail, type TemplateName, type TEMPLATES } from './templates';
import type { EmailAttachment } from './assets';
import { emailBranding } from './branding';

/**
 * Transactional email transport.
 *
 * ---------------------------------------------------------------------------
 * THE CENTRAL GUARANTEE: SENDING MAIL CANNOT FAIL A REQUEST
 * ---------------------------------------------------------------------------
 * `sendEmail` never throws and never rejects. Registration must not 500
 * because the mail host is rate limiting us, and a verification decision must
 * not roll back because a mailbox bounced - the decision is the product, the
 * email is a courtesy about it.
 *
 * Call sites use `sendEmailAsync(...)` AFTER their writes have committed.
 * It schedules the send with Next's `after()`, so the response is not delayed
 * AND the serverless invocation stays alive until the message has actually
 * been handed to the mail server. A bare floating promise does not have that
 * second property: on Vercel the function is frozen once the response is
 * sent, and the mail silently never leaves.
 *
 * ---------------------------------------------------------------------------
 * TRANSPORTS, FIRST COMPLETE ONE WINS
 * ---------------------------------------------------------------------------
 *   1. GMAIL_USER + GMAIL_APP_PASSWORD   - the platform mailbox
 *      (campushubsupport@gmail.com) over smtp.gmail.com:465, implicit TLS.
 *   2. SMTP_USER + SMTP_PASSWORD (+ SMTP_HOST / SMTP_PORT) - any other SMTP
 *      server. Kept for deployments that already use it.
 *   3. RESEND_API_KEY - once the platform sends from its own verified domain.
 *
 * None configured is a no-op (logged once; loudly in production).
 *
 * ---------------------------------------------------------------------------
 * WHY GMAIL NEEDS AN APP PASSWORD, NOT THE ACCOUNT PASSWORD
 * ---------------------------------------------------------------------------
 * Google refuses plain account passwords over SMTP ("535 Username and Password
 * not accepted"). With 2-Step Verification enabled, the account can mint a
 * 16-character App Password (https://myaccount.google.com/apppasswords). It is
 * scoped to mail, revocable on its own, and is the only credential that works.
 * Google displays it in four groups of four; the spaces are stripped here.
 *
 * Gmail caps a free account at roughly 500 messages/day - fine for a project
 * deployment, not for a large user base (that is when Resend + a domain wins).
 *
 * ---------------------------------------------------------------------------
 * SECRETS
 * ---------------------------------------------------------------------------
 * The password is read from server-side env only and is never logged: log
 * lines carry the template NAME and the provider's error message, never the
 * recipient, the body or any credential.
 */

export type SendResult =
  | { ok: true; id: string | null; skipped?: 'not-configured' | 'duplicate' }
  | { ok: false; error: string };

export type SendOptions = {
  dedupeKey?: string;
  /**
   * Internal: set by the outbox retrier so a failed retry updates its own
   * outbox row instead of queueing a second copy.
   */
  noQueue?: boolean;
};

const DEFAULT_SENDER_NAME = 'UniPath';
const MAX_ATTEMPTS = 3;
const DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type SmtpSettings = { user: string; pass: string; host: string; port: number };

type Transport =
  | { kind: 'smtp'; client: Transporter; user: string }
  | { kind: 'resend'; client: Resend }
  | null;

let smtp: Transporter | null = null;
let resend: Resend | null = null;
const warned = new Set<string>();

function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  if (process.env.NODE_ENV === 'production') console.error(message);
  else console.warn(message);
}

function smtpSettings(): SmtpSettings | null {
  const gmailUser = process.env.GMAIL_USER?.trim();
  const gmailPass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  if (gmailUser && gmailPass) {
    return { user: gmailUser, pass: gmailPass, host: 'smtp.gmail.com', port: 465 };
  }

  const user = process.env.SMTP_USER?.trim();
  /**
   * Whitespace is stripped here for the SAME reason it is stripped from
   * GMAIL_APP_PASSWORD above: Google displays an App Password as four groups of
   * four, and it is almost always pasted with those spaces intact. When the
   * SMTP_* pair points at smtp.gmail.com - which is this file's own default
   * host - a value carrying spaces is rejected with 535 BadCredentials, which
   * is indistinguishable from a genuinely wrong password. Stripping is safe for
   * other providers too: no SMTP password may contain leading, trailing or
   * embedded whitespace and still survive the protocol's own tokenisation.
   */
  const pass = process.env.SMTP_PASSWORD?.replace(/\s+/g, '');
  if (user && pass) {
    return {
      user,
      pass,
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
    };
  }
  return null;
}

/**
 * Resolves the transport lazily: a module-scope constructor would run during
 * `next build`, where an SMTP handshake would hang or fail the build.
 */
function getTransport(): Transport {
  const settings = smtpSettings();
  if (settings) {
    smtp ??= nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      // 465 is implicit TLS; 587 upgrades via STARTTLS. Derived from the port
      // because `secure: true` on 587 hangs until timeout instead of failing.
      secure: settings.port === 465,
      requireTLS: settings.port !== 465,
      auth: { user: settings.user, pass: settings.pass },
      // Bounded so an unresponsive mail host cannot pin an invocation open.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return { kind: 'smtp', client: smtp, user: settings.user };
  }

  const key = process.env.RESEND_API_KEY;
  if (key) {
    resend ??= new Resend(key);
    return { kind: 'resend', client: resend };
  }

  warnOnce(
    'unconfigured',
    '[email] No transport configured - set GMAIL_USER + GMAIL_APP_PASSWORD (Gmail App Password), ' +
      'SMTP_USER + SMTP_PASSWORD, or RESEND_API_KEY. Transactional email is disabled.',
  );
  return null;
}

/**
 * The From header.
 *
 * Gmail rewrites any From that is not the authenticated mailbox (or a verified
 * alias of it), so EMAIL_FROM contributes its display name and the address is
 * always the mailbox that actually authenticated.
 */
function fromAddress(transport: NonNullable<Transport>): string {
  const configured = process.env.EMAIL_FROM?.trim() ?? '';
  if (transport.kind === 'resend') return configured;

  const match = /^(.*?)\s*<([^>]+)>$/.exec(configured);
  const name = (match?.[1] ?? '').replace(/^"|"$/g, '').trim() || DEFAULT_SENDER_NAME;
  const address = (match?.[2] ?? configured).trim();
  if (address && address.toLowerCase() !== transport.user.toLowerCase()) {
    warnOnce('from', `[email] EMAIL_FROM does not match the authenticated mailbox; sending as ${transport.user}`);
  }
  return `${name} <${transport.user}>`;
}

/** SMTP 4xx and network-level failures are worth another attempt; auth failures are not. */
function isTransient(error: unknown): boolean {
  const e = error as { code?: string; responseCode?: number; name?: string };
  if (e.code === 'EAUTH') return false;
  if (typeof e.responseCode === 'number') return e.responseCode >= 400 && e.responseCode < 500;
  return ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(
    e.code ?? '',
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function deliver(
  transport: NonNullable<Transport>,
  message: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    attachments?: EmailAttachment[];
  },
): Promise<string | null> {
  const { attachments = [], ...body } = message;

  const headers: Record<string, string> = {
    // Tells well-behaved clients not to auto-reply and servers not to bounce
    // to the recipient's own address.
    'Auto-Submitted': 'auto-generated',
    /**
     * Gmail and Outlook surface a native "unsubscribe" control from this
     * header, and its ABSENCE counts against sender reputation even for
     * transactional mail. It points at notification settings because that is
     * what the platform actually offers - see branding.ts.
     */
    'List-Unsubscribe': `<${emailBranding().unsubscribeUrl}>`,
  };

  if (transport.kind === 'smtp') {
    /**
     * Inline images. `cid` plus contentDisposition 'inline' is what makes the
     * attachment render in place of src="cid:logo" rather than appearing as a
     * downloadable file at the bottom of the message.
     *
     * nodemailer defaults the whole message to UTF-8, which is what carries
     * the Azerbaijani characters in the templates through intact; no explicit
     * charset is set anywhere, deliberately, so nothing can narrow it.
     */
    const info = await transport.client.sendMail({
      ...body,
      headers,
      attachments: attachments.map((asset) => ({
        filename: asset.filename,
        content: asset.content,
        cid: asset.cid,
        contentType: asset.contentType,
        contentDisposition: 'inline' as const,
      })),
    });
    return info.messageId ?? null;
  }

  /**
   * Resend receives the HTML without inline attachments. Its API has no
   * Content-ID support, so a cid: src would arrive broken; url mode is the
   * supported configuration for this transport and the images resolve to
   * absolute URLs before they ever reach here.
   */
  if (attachments.length > 0) {
    warnOnce(
      'resend-cid',
      '[email] EMAIL_ASSET_MODE=cid is not supported by the Resend transport; ' +
        'images will be missing. Set EMAIL_ASSET_MODE=url and EMAIL_ASSET_BASE_URL.',
    );
  }

  const { data, error } = await transport.client.emails.send({ ...body, headers });
  if (error) {
    const transient = ['rate_limit_exceeded', 'application_error', 'internal_server_error'].includes(
      error.name,
    );
    throw Object.assign(new Error(error.message), transient ? { code: 'ECONNECTION' } : { code: 'EREJECTED' });
  }
  return data?.id ?? null;
}

function dedupeRef(dedupeKey: string) {
  const id = createHash('sha256').update(dedupeKey).digest('hex');
  return adminDb().collection(COLLECTIONS.emailDispatches).doc(id);
}

/**
 * Claims a dedupe key. Returns false when it was already claimed. A Firestore
 * outage fails OPEN (the mail is sent): a duplicate courtesy email is a far
 * smaller harm than a missing verification decision.
 */
async function claim(dedupeKey: string, name: string): Promise<boolean> {
  try {
    await dedupeRef(dedupeKey).create({
      template: name,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + DEDUPE_TTL_MS),
    });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 6) return false; // ALREADY_EXISTS
    console.error(`[email] dedupe check unavailable for "${name}"; sending anyway`);
    return true;
  }
}

/**
 * Sends one templated message. Resolves to a result; never rejects.
 *
 * @param to      recipient address. Never logged.
 * @param name    template key from templates.ts
 * @param params  that template's parameters, type-checked against it
 */
export async function sendEmail<K extends TemplateName>(
  to: string,
  name: K,
  params: Parameters<(typeof TEMPLATES)[K]>[0],
  options: SendOptions = {},
): Promise<SendResult> {
  let claimed = false;
  try {
    const transport = getTransport();
    // Not an error: a developer machine with no mail credentials must still
    // be able to register an account.
    if (!transport) return { ok: true, id: null, skipped: 'not-configured' };

    const from = fromAddress(transport);
    if (!from) {
      console.error('[email] EMAIL_FROM is required for the Resend transport');
      return { ok: false, error: 'EMAIL_FROM not configured' };
    }

    if (options.dedupeKey) {
      if (!(await claim(options.dedupeKey, name))) return { ok: true, id: null, skipped: 'duplicate' };
      claimed = true;
    }

    const { subject, html, text, attachments } = buildEmail(name, params);

    for (let attempt = 1; ; attempt++) {
      try {
        const id = await deliver(transport, { from, to, subject, html, text, attachments });
        console.info('[email] sent "' + name + '" to ' + maskAddress(to) + (id ? ' (' + id + ')' : ''));
        return { ok: true, id };
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isTransient(error)) throw error;
        await sleep(attempt * 1_500);
      }
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'unknown error';
    const queue = !isPermanent(cause) && !options.noQueue;
    console.error(
      '[email] send failed for "' + name + '" to ' + maskAddress(to) + ': ' + message +
        (queue ? ' - queued for retry' : ''),
    );
    if (queue) {
      // The dedupe claim is KEPT: the outbox now owns delivery of this event,
      // and a re-run of the same event must not send a second copy.
      await queueForRetry(to, name, params, message).catch((error) =>
        console.error('[email] could not queue "' + name + '" for retry', error),
      );
    } else if (claimed && options.dedupeKey) {
      // Release the claim so a later retry of the same event can still send.
      await dedupeRef(options.dedupeKey).delete().catch(() => {});
    }
    return { ok: false, error: message };
  }
}

/**
 * Send without delaying the response. Call it AFTER the writes commit.
 *
 * Inside a request, `after()` keeps the invocation alive until the send has
 * finished. Outside one (scripts, tests) `after()` throws, and the send simply
 * runs as a background promise.
 */
export function sendEmailAsync<K extends TemplateName>(
  to: string,
  name: K,
  params: Parameters<(typeof TEMPLATES)[K]>[0],
  options?: SendOptions,
): void {
  const task = async () => {
    await sendEmail(to, name, params, options);
  };
  try {
    after(task);
  } catch {
    void task();
  }
}

/**
 * Confirms the credentials actually work, without sending anything.
 * Wired to `npm run email:verify`.
 */
export async function verifyTransport(): Promise<
  { ok: true; kind: 'smtp' | 'resend'; from: string } | { ok: false; error: string }
> {
  const transport = getTransport();
  if (!transport) return { ok: false, error: 'No transport configured.' };

  if (transport.kind === 'smtp') {
    try {
      await transport.client.verify();
      return { ok: true, kind: 'smtp', from: fromAddress(transport) };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : 'unknown error' };
    }
  }

  // Resend has no credential probe that does not send a message.
  return { ok: true, kind: 'resend', from: fromAddress(transport) };
}

// ---------------------------------------------------------------------------
// Durable retry: the email outbox
// ---------------------------------------------------------------------------
//
// sendEmail() already retries transient failures in-process. Anything still
// failing after that (SMTP down, credentials being rotated) is parked in the
// `emailOutbox` collection and retried with backoff by retryQueuedEmails(),
// which the scheduler worker runs every minute and GET /api/cron/email-outbox
// exposes to HTTP schedulers. Mail therefore survives an outage without ever
// blocking or failing the request that triggered it.

const OUTBOX_MAX_ATTEMPTS = 6;
/** 2, 4, 8, 16, 32, then 60 minutes between attempts. */
const backoffMs = (attempts: number) => Math.min(60, 2 ** attempts) * 60_000;

/** Logs never carry a full address. */
function maskAddress(address: string): string {
  const [user = '', domain = ''] = address.split('@');
  return user.slice(0, 2) + '***@' + domain;
}

/** A rejected recipient or message will fail the same way on every retry. */
function isPermanent(error: unknown): boolean {
  const e = error as { code?: string; responseCode?: number };
  // Bad credentials (SMTP 535 / EAUTH) are a configuration problem that gets
  // fixed, so the message must be retried afterwards, not dropped.
  if (e.code === 'EAUTH') return false;
  if (e.code === 'EREJECTED') return true;
  return typeof e.responseCode === 'number' && e.responseCode >= 500 && e.responseCode !== 521;
}

async function queueForRetry(to: string, name: TemplateName, params: unknown, error: string): Promise<void> {
  await adminDb()
    .collection(COLLECTIONS.emailOutbox)
    .add({
      to,
      template: name,
      params: JSON.parse(JSON.stringify(params ?? {})),
      attempts: 1,
      lastError: error.slice(0, 500),
      nextAttemptAt: new Date(Date.now() + backoffMs(1)),
      createdAt: new Date(),
    });
}

/** Retries due outbox entries. Safe to run concurrently with itself. */
export async function retryQueuedEmails(
  limit = 20,
): Promise<{ attempted: number; sent: number; failed: number }> {
  const outbox = adminDb().collection(COLLECTIONS.emailOutbox);
  // Single-field range: no composite index. Exhausted entries have a null
  // nextAttemptAt, which a range never matches.
  const due = await outbox.where('nextAttemptAt', '<=', new Date()).limit(limit).get();

  let sent = 0;
  let failed = 0;
  for (const doc of due.docs) {
    const item = doc.data() as { to: string; template: TemplateName; params: unknown; attempts?: number };
    const result = await sendEmail(item.to, item.template, item.params as never, { noQueue: true });
    if (result.ok) {
      await doc.ref.delete();
      sent += 1;
      continue;
    }
    failed += 1;
    const attempts = (item.attempts ?? 1) + 1;
    await doc.ref.update(
      attempts >= OUTBOX_MAX_ATTEMPTS
        ? { attempts, lastError: result.error.slice(0, 500), nextAttemptAt: null, failedAt: new Date() }
        : { attempts, lastError: result.error.slice(0, 500), nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) },
    );
  }

  if (due.size) console.info('[email] outbox retry: ' + sent + ' sent, ' + failed + ' failed of ' + due.size);
  return { attempted: due.size, sent, failed };
}
