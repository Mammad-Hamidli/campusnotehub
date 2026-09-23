/**
 * The platform's mail identity: who this project is allowed to BE in email.
 *
 * ---------------------------------------------------------------------------
 * ONE MAILBOX, AND ONLY ONE
 * ---------------------------------------------------------------------------
 *   supportcampushub@gmail.com
 *
 * It authenticates to Gmail's SMTP with an App Password, signs every outbound
 * transactional message, carries the Reply-To on all of them, is the address
 * printed in footers and on the legal pages, and is the IMAP mailbox drained
 * by src/lib/email/inbox.ts. Outbound and inbound are the same account, so
 * there is exactly one credential to rotate and one inbox to work.
 *
 * ---------------------------------------------------------------------------
 * WHY AN ALLOWLIST AND NOT JUST A DEFAULT
 * ---------------------------------------------------------------------------
 * Any other mailbox is one edited dashboard variable away from becoming the
 * platform's public From address, and no deployment would report it: mail would
 * simply start going out signed by someone else, with replies landing in their
 * inbox and their address entering every recipient's address book, the sending
 * reputation data and any archive of the messages. A default does not prevent
 * that - it is only what happens when nobody sets anything.
 *
 * So the allowlist below is closed. An address outside it is a configuration
 * ERROR, not a preference: rejected at boot by src/server/env-check.ts and
 * rejected again at send time, where it is treated as permanent so the message
 * is never parked in the outbox to be retried with the same bad identity.
 */

/** The one mailbox this project may send from or read. */
export const MAIL_ACCOUNT = 'supportcampushub@gmail.com';

/** The complete set of addresses this project may send from or read. */
export const ROLE_MAILBOXES: readonly string[] = [MAIL_ACCOUNT];

const DEFAULT_SENDER_NAME = 'CampusNoteHub';

const allowed = new Set(ROLE_MAILBOXES);

/** `"Name" <a@b>` or `a@b` -> `a@b`, lowercased. */
function bareAddress(value: string | undefined): string {
  const raw = value?.trim() ?? '';
  if (!raw) return '';
  return (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase();
}

export function isRoleMailbox(value: string | undefined): boolean {
  return allowed.has(bareAddress(value));
}

/**
 * Validates one configured address against the allowlist.
 *
 * Empty means "not configured" and yields `fallback` - a deployment that sets
 * nothing still sends correctly. A NON-empty value outside the allowlist
 * throws: somebody typed a real address that this project must not use, and
 * silently substituting the right one would hide the mistake in the one place
 * where it matters.
 */
export function roleMailbox(value: string | undefined, variable: string, fallback: string): string {
  const address = bareAddress(value);
  if (!address) return fallback;
  if (!allowed.has(address)) {
    throw Object.assign(
      new Error(
        `${variable}=<${address}> is not the platform mailbox. Only ${MAIL_ACCOUNT} ` +
          'may be used for project email; other addresses are not permitted.',
      ),
      { code: 'EIDENTITY' },
    );
  }
  return address;
}

/** Same check, but survivable: renders fall back to the canonical mailbox. */
export function roleMailboxOrDefault(value: string | undefined, variable: string, fallback: string): string {
  try {
    return roleMailbox(value, variable, fallback);
  } catch (error) {
    console.error(`[email] ${(error as Error).message} Using ${fallback}.`);
    return fallback;
  }
}

/** Display name only. EMAIL_FROM's address half is ignored here; see fromHeader(). */
export function senderName(): string {
  const configured = process.env.EMAIL_SENDER_NAME?.trim();
  if (configured) return configured;
  const fromDisplay = /^(.*?)\s*</.exec(process.env.EMAIL_FROM?.trim() ?? '')?.[1];
  return fromDisplay?.replace(/^"|"$/g, '').trim() || DEFAULT_SENDER_NAME;
}

/** The authenticated sending mailbox, after validation. */
export function senderAddress(): string {
  return roleMailbox(process.env.EMAIL_FROM, 'EMAIL_FROM', MAIL_ACCOUNT);
}

/** The mailbox humans reach, after validation. Same account as the sender. */
export function supportAddress(): string {
  return roleMailboxOrDefault(process.env.EMAIL_SUPPORT_ADDRESS, 'EMAIL_SUPPORT_ADDRESS', MAIL_ACCOUNT);
}

/** `CampusNoteHub <supportcampushub@gmail.com>` */
export function fromHeader(): string {
  return `${senderName()} <${senderAddress()}>`;
}

/**
 * Replies go to the same monitored mailbox that sent the message. Set
 * explicitly rather than left to the client's default so a deployment that
 * ever splits the two addresses again keeps replies pointed at the inbox a
 * human actually reads.
 */
export function replyToHeader(): string {
  return supportAddress();
}
