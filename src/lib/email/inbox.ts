import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { adminDb } from '@/lib/firebase/admin.core';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { MAIL_ACCOUNT, roleMailbox } from './identity';

/**
 * Inbound mail: the platform mailbox, over IMAP.
 *
 * ---------------------------------------------------------------------------
 * WHY THE APP READS A MAILBOX AT ALL
 * ---------------------------------------------------------------------------
 * Every outbound message carries `Reply-To: supportcampushub@gmail.com`, so
 * replies are not an edge case - they are the documented way to reach the
 * platform, printed in the footer of every email and on the legal pages. A
 * mailbox nobody drains makes all of that a lie, and the failure is silent:
 * users write, nothing answers, and no log records it.
 *
 * This reads UNSEEN messages, records each one in Firestore where the admin
 * side can see it, and marks it seen so the next run does not re-read it. It
 * does NOT reply, delete, or move anything by default - a human still works
 * the mailbox in Gmail, and this is the copy the product can act on.
 *
 * ---------------------------------------------------------------------------
 * THE MAILBOX IS FIXED
 * ---------------------------------------------------------------------------
 * IMAP_USER goes through the same allowlist check as the sender: reading any
 * other inbox from application code would put private correspondence into the
 * product's database, which is a far larger mistake than a misconfigured From
 * header and just as easy to make by editing one variable.
 *
 * ---------------------------------------------------------------------------
 * SECRETS AND CONTENT
 * ---------------------------------------------------------------------------
 * The password is server-side env only and never logged. Message bodies are
 * stored (that is the point of a ticket), but log lines carry only counts and
 * UIDs - never a sender, a subject or a body.
 */

export type InboxResult = { fetched: number; stored: number; skipped: number };

/** Firestore documents are capped at 1 MiB; a long thread easily exceeds it. */
const MAX_BODY_CHARS = 32_000;

type ImapSettings = { user: string; pass: string; host: string; port: number };

function imapSettings(): ImapSettings | null {
  // Throws EIDENTITY on anything but a role mailbox - see ./identity.ts.
  const user = roleMailbox(process.env.IMAP_USER, 'IMAP_USER', MAIL_ACCOUNT);
  // Stripped for the same reason as SMTP_PASSWORD: an app-specific password is
  // routinely pasted with a trailing space, and the server reports that as a
  // plain authentication failure.
  const pass = process.env.IMAP_PASSWORD?.replace(/\s+/g, '');
  if (!pass) return null;

  return {
    user,
    pass,
    // Gmail. IMAP must be switched on for the account (Gmail > Settings >
    // Forwarding and POP/IMAP), and the credential is the same App Password
    // SMTP uses - the account password is refused here too.
    host: process.env.IMAP_HOST?.trim() || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT || 993),
  };
}

/**
 * One deterministic id per message.
 *
 * Keyed on Message-ID rather than the IMAP UID because a UID is only unique
 * within one mailbox and is reassigned if the mailbox is recreated, while
 * Message-ID follows the message. Falling back to the UID covers the rare
 * sender that omits the header; `create()` then does the deduplication.
 */
function documentId(messageId: string | undefined, uid: number): string {
  return createHash('sha256').update(messageId?.trim() || `uid:${uid}`).digest('hex');
}

/**
 * Reads unseen support mail into `supportInbox`.
 *
 * Throws on connection or auth failure: unlike an outbound send - which must
 * never fail a user's request - this runs from a cron entry point whose only
 * job is this, so a failure belongs in that endpoint's response and in the
 * platform's logs rather than being swallowed.
 */
export async function drainSupportInbox(limit = 25): Promise<InboxResult> {
  const settings = imapSettings();
  if (!settings) {
    console.warn('[inbox] IMAP_PASSWORD is not set; the support mailbox is not being read.');
    return { fetched: 0, stored: 0, skipped: 0 };
  }

  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    // 993 is implicit TLS, which is the only port Gmail offers for IMAP.
    secure: settings.port === 993,
    auth: { user: settings.user, pass: settings.pass },
    // The library logs every IMAP command at info level, including the mailbox
    // and message metadata. Off by default; the counts below are the record.
    logger: false,
    // Bounded so an unresponsive mail host cannot pin a serverless invocation
    // open for its whole maxDuration.
    socketTimeout: 30_000,
    greetingTimeout: 10_000,
  });

  const result: InboxResult = { fetched: 0, stored: 0, skipped: 0 };

  await client.connect();
  try {
    // The lock serialises access to the mailbox for this connection; IMAP has
    // one selected mailbox at a time and concurrent operations corrupt state.
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return result;

      // Oldest first, so a backlog is worked through in the order it arrived
      // and a burst does not starve the messages that have waited longest.
      for (const uid of uids.slice(0, limit)) {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message || !message.source) continue;
        result.fetched += 1;

        const parsed = await simpleParser(message.source);
        const stored = await store(parsed, uid);
        if (stored) result.stored += 1;
        else result.skipped += 1;

        // Only after the row is safely written: a crash before this point
        // leaves the message unseen and it is simply read again, whereas
        // marking first would lose it.
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    // logout() is the clean QUIT. Without it Gmail holds the session open and
    // counts it against the account's concurrent-connection limit.
    await client.logout().catch(() => client.close());
  }

  if (result.fetched) {
    console.info(`[inbox] ${result.stored} stored, ${result.skipped} duplicates of ${result.fetched} fetched`);
  }
  return result;
}

type Parsed = Awaited<ReturnType<typeof simpleParser>>;

/** Returns false when this message was already recorded. */
async function store(parsed: Parsed, uid: number): Promise<boolean> {
  const from = parsed.from?.value?.[0];
  const body = (parsed.text ?? '').slice(0, MAX_BODY_CHARS);

  const row = {
    messageId: parsed.messageId ?? null,
    uid,
    fromAddress: from?.address?.toLowerCase() ?? null,
    fromName: from?.name || null,
    subject: parsed.subject?.slice(0, 500) ?? null,
    body,
    truncated: (parsed.text?.length ?? 0) > MAX_BODY_CHARS,
    /**
     * Attachment BYTES are deliberately not stored. A mail attachment is
     * arbitrary untrusted content of arbitrary size; it stays in the Gmail
     * mailbox, where a human opens it, and the product keeps only the fact
     * that it exists.
     */
    attachments: (parsed.attachments ?? []).map((file) => ({
      filename: file.filename ?? null,
      contentType: file.contentType ?? null,
      size: file.size ?? 0,
    })),
    receivedAt: parsed.date ?? new Date(),
    status: 'new' as const,
    createdAt: new Date(),
  };

  try {
    await adminDb()
      .collection(COLLECTIONS.supportInbox)
      .doc(documentId(parsed.messageId, uid))
      .create(row);
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 6) return false; // ALREADY_EXISTS
    throw error;
  }
}

