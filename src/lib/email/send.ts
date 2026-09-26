import { createHash } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { after } from 'next/server';
import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { buildEmail, type TemplateName, type TEMPLATES } from './templates';
import { MAIL_ACCOUNT, fromHeader, replyToHeader, roleMailbox } from './identity';
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
 * TRANSPORT: GMAIL SMTP, AUTHENTICATED AS supportcampushub@gmail.com
 * ---------------------------------------------------------------------------
 * SMTP_USER + SMTP_PASSWORD over SMTP_HOST (default smtp.gmail.com:465,
 * implicit TLS). SMTP_USER must be the platform mailbox - see ./identity.ts,
 * which is what keeps any other address out of the From header whatever a
 * deployment's variables happen to say. This is the ONLY transport: there is
 * no API fallback to fall out of sync with it.
 *
 * Not configured is a no-op (logged once; loudly in production).
 *
 * ---------------------------------------------------------------------------
 * WHY GMAIL NEEDS AN APP PASSWORD, NOT THE ACCOUNT PASSWORD
 * ---------------------------------------------------------------------------
 * Google removed password-based SMTP for ordinary accounts ("Less secure app
 * access"). The account password is refused outright with "535-5.7.8 Username
 * and Password not accepted". With two-factor authentication on - which this
 * mailbox must have, since it is what mints the credential - the account
 * generates a 16-character App Password instead
 * (myaccount.google.com > Security > 2-Step Verification > App passwords).
 * It is scoped to one client, revocable on its own without touching the login,
 * and is the only credential that works here.
 *
 * From and Reply-To are both that same mailbox. Gmail rewrites a From it has
 * not verified as a send-as alias on the authenticated account, so keeping the
 * two identical is what makes the header the user sees match the header that
 * was actually authenticated.
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

const MAX_ATTEMPTS = 3;
const DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type SmtpSettings = { user: string; pass: string; host: string; port: number };

type Transport = { kind: 'smtp'; client: Transporter; user: string } | null;

let smtp: Transporter | null = null;
const warned = new Set<string>();

/**
 * Auth-failure cooldown.
 *
 * A rejected login (SMTP 535 / EAUTH) will be rejected again on the next
 * request until someone replaces the credential - and every one of those
 * attempts is a failed login against the mailbox. Gmail answers a burst of
 * them by temporarily locking the account ("454 4.7.0 Too many login
 * attempts"), which turns a config fix into a wait. So after one rejection the
 * transport is not tried again for AUTH_COOLDOWN_MS: messages go straight to
 * the outbox, which delivers them once the credential works.
 */
const AUTH_COOLDOWN_MS = 5 * 60_000;
let authRejectedUntil = 0;

function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  if (process.env.NODE_ENV === 'production') console.error(message);
  else console.warn(message);
}

function smtpSettings(): SmtpSettings | null {
  /**
   * Throws (EIDENTITY) when SMTP_USER names anything but a role mailbox.
   * Deliberate: authenticating as a person's mailbox is the exact failure this
   * module is arranged to prevent, and a silent fallback would hide it.
   */
  const user = roleMailbox(process.env.SMTP_USER, 'SMTP_USER', MAIL_ACCOUNT);
  /**
   * Whitespace is stripped because an application-specific password is
   * routinely pasted out of a dashboard with a trailing space or a line break,
   * and the server answers that with the same 535 as a genuinely wrong
   * password - an hour spent debugging a credential that was correct.
   * Stripping is safe: no SMTP password may contain leading, trailing or
   * embedded whitespace and still survive the protocol's own tokenisation.
   */
  const pass = process.env.SMTP_PASSWORD?.replace(/\s+/g, '');
  if (!pass) return null;

  return {
    user,
    pass,
    // Overridable so a deployment blocked from 465 can move to
    // smtp.gmail.com:587 (STARTTLS) without a code change.
    host: process.env.SMTP_HOST?.trim() || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
  };
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

  warnOnce(
    'unconfigured',
    '[email] No transport configured - set SMTP_PASSWORD to the Gmail App Password for ' +
      `${MAIL_ACCOUNT}. Transactional email is disabled.`,
  );
  return null;
}

/**
 * The From header: always a platform role mailbox, never a person.
 *
 * The address comes from ./identity.ts rather than straight out of the
 * environment, so an EMAIL_FROM pointing anywhere else throws here instead of
 * going out on a message. Gmail would silently rewrite a From it has not
 * verified on the authenticated account anyway, and silent rewriting by a
 * provider is not a control this project should be relying on.
 */
function fromAddress(transport: NonNullable<Transport>): string {
  const from = fromHeader();
  const address = (/<([^>]+)>/.exec(from)?.[1] ?? from).toLowerCase();
  if (address !== transport.user.toLowerCase()) {
    warnOnce(
      'from',
      `[email] EMAIL_FROM <${address}> is not the authenticated mailbox <${transport.user}>; ` +
        'Gmail rewrites that to the authenticated address unless it is a verified send-as alias.',
    );
  }
  return from;
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
    replyTo: string;
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
    // Every message invites a reply to the monitored mailbox - never to the
    // sending one, and never to a person.
    const replyTo = replyToHeader();

    if (options.dedupeKey) {
      if (!(await claim(options.dedupeKey, name))) return { ok: true, id: null, skipped: 'duplicate' };
      claimed = true;
    }

    if (Date.now() < authRejectedUntil) {
      throw Object.assign(new Error('SMTP credentials rejected recently; skipping login attempt'), {
        code: 'EAUTH',
      });
    }

    const { subject, html, text, attachments } = buildEmail(name, params);

    for (let attempt = 1; ; attempt++) {
      try {
        const id = await deliver(transport, { from, replyTo, to, subject, html, text, attachments });
        console.info('[email] sent "' + name + '" to ' + maskAddress(to) + (id ? ' (' + id + ')' : ''));
        return { ok: true, id };
      } catch (error) {
        if ((error as { code?: string }).code === 'EAUTH') {
          authRejectedUntil = Date.now() + AUTH_COOLDOWN_MS;
          warnOnce(
            'eauth',
            '[email] The mail server REJECTED the login (SMTP 535). Every email is being queued in ' +
              'emailOutbox until this is fixed. For Gmail: generate a new App Password ' +
              '(myaccount.google.com > Security > 2-Step Verification > App passwords) for the ' +
              'SMTP_USER mailbox, put it in SMTP_PASSWORD, restart, and check with ' +
              '"npm run email:verify".',
          );
        }
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
    const result = await sendEmail(to, name, params, options);
    // A real delivery proves the transport works right now, which is the
    // moment to flush anything parked while it did not. Runs inside the same
    // after() task, so a serverless invocation stays alive until it is done.
    if (result.ok && !result.skipped) await drainOutboxOpportunistically();
  };
  try {
    after(task);
  } catch {
    void task();
  }
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
  // A non-platform sender address (see ./identity.ts) would be re-sent from the
  // same forbidden identity on every retry, so it is never queued.
  if (e.code === 'EIDENTITY') return true;
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

/**
 * How long a runner holds an outbox row while it sends it. Long enough to
 * cover one send with its in-process retries (well under a minute), short
 * enough that a runner that died mid-send does not strand the row.
 */
const OUTBOX_LEASE_MS = 5 * 60_000;

/**
 * Takes a due row for this runner by pushing its nextAttemptAt past the lease,
 * in a transaction. Returns false when another runner got there first.
 *
 * This is what makes concurrent runners safe: the scheduler, the cron route
 * and the opportunistic drain below can all overlap, and without the lease
 * two of them would read the same due row and each send it.
 */
async function leaseOutboxRow(ref: FirebaseFirestore.DocumentReference): Promise<boolean> {
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = snap.get('nextAttemptAt') as FirebaseFirestore.Timestamp | null | undefined;
    if (!snap.exists || !next || next.toMillis() > Date.now()) return false;
    tx.update(ref, { nextAttemptAt: new Date(Date.now() + OUTBOX_LEASE_MS) });
    return true;
  });
}

/** Retries due outbox entries. Safe to run concurrently with itself (see leaseOutboxRow). */
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
    if (!(await leaseOutboxRow(doc.ref))) continue;
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

/**
 * Minimum gap between opportunistic drains on one server instance. The drain
 * is one indexed query when the outbox is empty, but a busy instance sends
 * many emails a minute and only needs to ask once.
 */
const DRAIN_INTERVAL_MS = 60_000;
let lastDrainAt = 0;

/**
 * Flushes the outbox from the app itself, so parked mail does not depend on
 * a separate worker being deployed.
 *
 * Without it the outbox drains only while `npm run worker:scheduler` runs or
 * something calls GET /api/cron/email-outbox - and when neither is set up,
 * every email queued during an SMTP outage stays queued forever, even after
 * the credential is fixed. Called after a SUCCESSFUL send, because that is
 * the one moment we know delivery works.
 */
async function drainOutboxOpportunistically(): Promise<void> {
  if (Date.now() - lastDrainAt < DRAIN_INTERVAL_MS) return;
  lastDrainAt = Date.now();
  await retryQueuedEmails(10).catch((error) => console.error('[email] opportunistic outbox drain failed', error));
}
