import nodemailer, { type Transporter } from 'nodemailer';
import { Resend } from 'resend';
import { buildEmail, type TemplateName, type TEMPLATES } from './templates';

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
 * That is why this returns a result object instead of throwing, and why the
 * call sites use `sendEmailAsync(...)` AFTER their transaction has committed
 * rather than inside it. Mailing from inside a transaction is the classic
 * version of this bug: the mail goes out, the transaction then rolls back, and
 * the user holds a message about something that did not happen.
 *
 * ---------------------------------------------------------------------------
 * TWO TRANSPORTS, AND WHY BOTH EXIST
 * ---------------------------------------------------------------------------
 * SMTP (default) - sends from an ordinary mailbox, including a Gmail account.
 *   This is the transport that supports "send everything from
 *   mammdhamidli04@gmail.com", because that is a MAILBOX, not a domain we
 *   control.
 *
 * Resend (optional) - the provider already in package.json. Kept because it is
 *   the right answer once the platform sends from its own domain: better
 *   deliverability, real bounce handling, and no per-account send caps.
 *
 * The choice is made by configuration, not by a code edit: whichever set of
 * credentials is present wins, SMTP first. Neither present is a no-op.
 *
 * ---------------------------------------------------------------------------
 * WHY GMAIL NEEDS AN APP PASSWORD, NOT THE ACCOUNT PASSWORD
 * ---------------------------------------------------------------------------
 * Google has disabled plain password auth for SMTP. An account with 2-Step
 * Verification on can mint a 16-character App Password
 * (https://myaccount.google.com/apppasswords) which is what SMTP_PASSWORD must
 * hold. It is scoped to mail only and revocable on its own, so it is also the
 * right credential to put in an env var - unlike the account password, which
 * would hand the whole Google account to anyone who read the file.
 *
 * Gmail also enforces a send quota of roughly 500 messages/day on a free
 * account. That is ample for a project deployment and is NOT ample for a real
 * user base, which is the point at which RESEND_API_KEY plus a verified domain
 * becomes the answer. Documented here so the ceiling is a known limit rather
 * than a mystery outage.
 */

export type SendResult =
  | { ok: true; id: string | null; skipped?: 'not-configured' }
  | { ok: false; error: string };

let smtp: Transporter | null = null;
let resend: Resend | null = null;
let warnedUnconfigured = false;

/**
 * The From address.
 *
 * Defaults to the project's own mailbox so a deployment that sets only the
 * SMTP credentials still sends from the right place. Overridable, because a
 * staging deploy must be able to send from somewhere else rather than mailing
 * real students from a test build.
 *
 * Note for the SMTP path: Gmail REWRITES this to the authenticated account
 * unless the address is a verified alias on that account. So setting
 * EMAIL_FROM to something else while authenticating as this mailbox does not
 * spoof anything - Gmail silently corrects it, which is the desired failure
 * direction.
 */
const DEFAULT_FROM = 'UniPath <mammdhamidli04@gmail.com>';

function fromAddress(): string {
  return process.env.EMAIL_FROM ?? DEFAULT_FROM;
}

type Transport =
  | { kind: 'smtp'; client: Transporter }
  | { kind: 'resend'; client: Resend }
  | null;

/**
 * Resolves the transport lazily.
 *
 * Lazy for the same reason src/lib/queue/connection.ts is lazy: a module-scope
 * constructor runs during `next build`, where the environment is not the
 * runtime environment, and an SMTP handshake at build time would either hang
 * or fail the build.
 */
function getTransport(): Transport {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (user && pass) {
    smtp ??= nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT ?? 465),
      // Port 465 is implicit TLS; 587 upgrades via STARTTLS. Deriving this
      // from the port rather than asking for a third env var removes the
      // commonest misconfiguration, which is `secure: true` on port 587 -
      // that hangs until timeout instead of failing loudly.
      secure: Number(process.env.SMTP_PORT ?? 465) === 465,
      auth: { user, pass },
      // Bounded so a mail host that stops responding cannot pin a serverless
      // invocation open until the platform kills it.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return { kind: 'smtp', client: smtp };
  }

  const key = process.env.RESEND_API_KEY;
  if (key) {
    resend ??= new Resend(key);
    return { kind: 'resend', client: resend };
  }

  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    console.warn(
      '[email] No transport configured - set SMTP_USER + SMTP_PASSWORD (Gmail App Password) ' +
        'or RESEND_API_KEY. Transactional email is disabled.',
    );
  }
  return null;
}

/**
 * Sends one templated message. Resolves to a result; never rejects.
 *
 * @param to      recipient address. Not logged - see below.
 * @param name    template key from templates.ts
 * @param params  that template's parameters, type-checked against it
 */
export async function sendEmail<K extends TemplateName>(
  to: string,
  name: K,
  params: Parameters<(typeof TEMPLATES)[K]>[0],
): Promise<SendResult> {
  try {
    const transport = getTransport();
    // Not an error: a developer machine with no mail credentials must still be
    // able to register an account. See the guarantee at the top of this file.
    if (!transport) return { ok: true, id: null, skipped: 'not-configured' };

    const { subject, html, text } = buildEmail(name, params);
    const from = fromAddress();

    if (transport.kind === 'smtp') {
      const info = await transport.client.sendMail({
        from,
        to,
        subject,
        html,
        text,
        headers: {
          // Tells well-behaved clients not to auto-reply and mail servers not
          // to send bounces to the recipient's own address.
          'Auto-Submitted': 'auto-generated',
        },
      });
      return { ok: true, id: info.messageId ?? null };
    }

    const { data, error } = await transport.client.emails.send({
      from,
      to,
      subject,
      html,
      text,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });

    if (error) {
      // The template NAME is logged, never the address or the body. An
      // application log is a lower-trust store than the database, and
      // "who was mailed what" is exactly the shape of data that should not
      // accumulate there.
      console.error(`[email] provider rejected "${name}": ${error.message}`);
      return { ok: false, error: error.message };
    }

    return { ok: true, id: data?.id ?? null };
  } catch (cause) {
    // Network failure, DNS, bad credentials, a provider outage. Swallowed on
    // purpose - see the guarantee at the top of this file.
    const message = cause instanceof Error ? cause.message : 'unknown error';
    console.error(`[email] send failed for "${name}": ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Fire-and-forget helper for request handlers.
 *
 * Exists so a call site reads as an intentional "send this, do not wait"
 * rather than as a floating promise someone forgot to await - and so the
 * no-floating-promises lint rule has something honest to point at.
 *
 * Call it AFTER the transaction commits.
 */
export function sendEmailAsync<K extends TemplateName>(
  to: string,
  name: K,
  params: Parameters<(typeof TEMPLATES)[K]>[0],
): void {
  void sendEmail(to, name, params);
}

/**
 * Confirms the credentials actually work, without sending anything.
 *
 * Wired to `npm run email:verify`. Bad SMTP credentials otherwise surface as
 * silent non-delivery: every send is swallowed by design, so a typo'd App
 * Password looks exactly like "no email configured" until somebody notices
 * nobody has received anything.
 */
export async function verifyTransport(): Promise<
  { ok: true; kind: 'smtp' | 'resend'; from: string } | { ok: false; error: string }
> {
  const transport = getTransport();
  if (!transport) return { ok: false, error: 'No transport configured.' };

  if (transport.kind === 'smtp') {
    try {
      await transport.client.verify();
      return { ok: true, kind: 'smtp', from: fromAddress() };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : 'unknown error' };
    }
  }

  // Resend has no cheap credential probe that does not send a message, so this
  // reports configuration rather than claiming a verification it did not do.
  return { ok: true, kind: 'resend', from: fromAddress() };
}
