import { appUrl, renderEmail, type EmailContent } from './layout';

/**
 * Every transactional message the platform sends, as data.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT GOVERNS THIS FILE
 * ---------------------------------------------------------------------------
 * NOTHING SENSITIVE GOES IN AN EMAIL. Mail is stored in plaintext on servers
 * nobody here controls, forwarded, and indexed by webmail providers. So:
 *
 *   - no passwords, ever, not even ones we just generated;
 *   - no verification document contents, no extracted names, no ID numbers -
 *     which is trivially satisfied, because under zero retention the platform
 *     does not have them to leak;
 *   - no specific fraud-signal codes on a rejection. Naming the check that
 *     fired ("SCREEN_RECAPTURE") is free tuning feedback for whoever is
 *     forging the document. This mirrors publicMessageKey() in
 *     src/lib/verification/policy.ts, which makes the same distinction for the
 *     same reason: quality problems get specific, actionable feedback because
 *     that is the only feedback that helps an honest user, and everything
 *     touching integrity collapses to one generic line.
 *   - no full email address or phone number echoed back in the body. The
 *     recipient already knows their own address, and it turns a forwarded
 *     message into a disclosure.
 *
 * Each template is a pure function returning EmailContent. Pure so it can be
 * snapshot-tested without a mail provider, and so "what does this message say"
 * is answerable by reading one function.
 */

export type TemplateName =
  | 'welcome'
  | 'verificationSubmitted'
  | 'verificationApproved'
  | 'verificationRejected'
  | 'accountFrozen'
  | 'accountUnfrozen'
  | 'roleAssigned'
  | 'noteUploaded'
  | 'notePurchased'
  | 'noteSold';

/** Greeting line. Nickname, never the legal name - see the User model. */
const hi = (nickname: string) => `Hi @${nickname},`;

export const TEMPLATES = {
  welcome: (p: { nickname: string; university?: string | null; faculty?: string | null }): EmailContent => ({
    subject: 'Welcome to UniPath',
    heading: 'Your account is ready',
    preheader: 'Verify your student status to unlock selling, mentoring and payouts.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: 'Your UniPath account has been created. You can already post in the feed, browse UniNotes and explore mentors.',
      },
      {
        kind: 'facts',
        rows: [
          { label: 'Handle', value: `@${p.nickname}` },
          ...(p.university ? [{ label: 'University', value: p.university }] : []),
          ...(p.faculty ? [{ label: 'Faculty', value: p.faculty }] : []),
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'One step left: verify your student status',
        // States the capability gate exactly as REQUIRES_VERIFICATION in
        // src/lib/permissions.ts defines it, so the email and the product
        // cannot tell the user different things.
        body: 'Until you are verified you can browse and post, but you cannot sell notes, offer mentoring, or withdraw funds.',
      },
      { kind: 'button', label: 'Verify my account', href: appUrl('/verify') },
      { kind: 'divider' },
      {
        kind: 'paragraph',
        text: 'If you did not create this account, please contact support and do not click the button above.',
      },
    ],
  }),

  verificationSubmitted: (p: { nickname: string }): EmailContent => ({
    subject: 'We received your verification documents',
    heading: 'Verification in progress',
    preheader: 'Your documents are being checked. Most results arrive within minutes.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: 'Your documents have been received and are being checked now. Most submissions are decided within a few minutes; if a human reviewer needs to look, it can take up to a few days.',
      },
      {
        kind: 'callout',
        tone: 'neutral',
        title: 'Your documents were not stored',
        // Worth stating plainly: it is the platform's most unusual property
        // and the thing a student is most likely to worry about.
        body: 'UniPath processes identity documents in memory and deletes them as soon as a decision is made. No copy is kept in our database or file storage.',
      },
      { kind: 'button', label: 'Check status', href: appUrl('/dashboard') },
    ],
  }),

  verificationApproved: (p: { nickname: string }): EmailContent => ({
    subject: 'You are verified on UniPath',
    heading: 'Verification approved',
    preheader: 'Selling, mentoring and payouts are now unlocked.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'callout', tone: 'success', title: 'Your student status is confirmed' },
      {
        kind: 'paragraph',
        text: 'You can now sell notes on UniNotes, book and offer mentoring sessions, and withdraw your balance. Your verified badge is visible next to your handle.',
      },
      { kind: 'button', label: 'Go to my dashboard', href: appUrl('/dashboard') },
    ],
  }),

  /**
   * `reason` MUST be a user-facing sentence about document QUALITY, never a
   * fraud signal. Callers pass publicMessageKey()'s rendered text or nothing.
   */
  verificationRejected: (p: { nickname: string; reason?: string | null; canResubmit: boolean }): EmailContent => ({
    subject: 'We could not verify your documents',
    heading: 'Verification unsuccessful',
    preheader: p.canResubmit ? 'You can submit again with a clearer photo.' : 'Please contact support.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'We could not confirm your student status',
        body: p.reason ?? undefined,
      },
      p.canResubmit
        ? {
            kind: 'paragraph' as const,
            text: 'You can try again. Photograph the original document in good light, keep all four corners in frame, and avoid glare or a photo of a screen.',
          }
        : {
            kind: 'paragraph' as const,
            text: 'You have used all available attempts. Please contact support if you believe this is a mistake.',
          },
      p.canResubmit
        ? { kind: 'button' as const, label: 'Try again', href: appUrl('/verify') }
        : { kind: 'button' as const, label: 'Contact support', href: appUrl('/contact') },
    ],
  }),

  accountFrozen: (p: { nickname: string; until?: string | null; reason?: string | null }): EmailContent => ({
    subject: 'Your UniPath account has been temporarily frozen',
    heading: 'Account temporarily frozen',
    preheader: 'You can still sign in and read, but posting and transactions are paused.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'callout',
        tone: 'danger',
        title: p.until ? `Frozen until ${p.until}` : 'Frozen until reviewed',
        body: p.reason ?? undefined,
      },
      {
        kind: 'paragraph',
        // Matches ALWAYS_ALLOWED in src/lib/permissions.ts exactly: a frozen
        // account keeps the read-only escape hatch.
        text: 'You can still sign in, read the feed, and browse notes and mentors. Posting, buying, selling, messaging and withdrawals are paused for the duration.',
      },
      {
        kind: 'paragraph',
        text: 'If you believe this was a mistake, reply to support with your handle and we will review it.',
      },
      { kind: 'button', label: 'Contact support', href: appUrl('/contact') },
    ],
  }),

  accountUnfrozen: (p: { nickname: string }): EmailContent => ({
    subject: 'Your UniPath account is active again',
    heading: 'Account restored',
    preheader: 'The freeze on your account has been lifted.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'callout', tone: 'success', title: 'The freeze has been lifted' },
      { kind: 'paragraph', text: 'Full access to your account has been restored. Thank you for your patience.' },
      { kind: 'button', label: 'Go to my dashboard', href: appUrl('/dashboard') },
    ],
  }),

  roleAssigned: (p: { nickname: string; role: string }): EmailContent => ({
    subject: `Your UniPath role is now ${p.role}`,
    heading: 'Your role has changed',
    preheader: `An administrator set your role to ${p.role}.`,
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'facts', rows: [{ label: 'New role', value: p.role }] },
      {
        kind: 'paragraph',
        text: 'Your permissions have been updated. If this is unexpected, contact support immediately - a role change you did not expect can indicate your account has been accessed by someone else.',
      },
      { kind: 'button', label: 'Review my account', href: appUrl('/settings') },
    ],
  }),

  noteUploaded: (p: { nickname: string; title: string }): EmailContent => ({
    subject: 'Your note was uploaded',
    heading: 'Upload received',
    preheader: `"${p.title}" is being processed.`,
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'facts', rows: [{ label: 'Note', value: p.title }] },
      {
        kind: 'paragraph',
        text: 'Your file passed our safety checks and has been saved as a draft. Publish it when you are ready and it will appear in UniNotes.',
      },
      { kind: 'button', label: 'Open UniNotes', href: appUrl('/notes') },
    ],
  }),

  notePurchased: (p: { nickname: string; title: string; priceLabel: string }): EmailContent => ({
    subject: 'Your UniNotes purchase',
    heading: 'Purchase confirmed',
    preheader: `You now have access to "${p.title}".`,
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'facts',
        rows: [
          { label: 'Note', value: p.title },
          { label: 'Paid', value: p.priceLabel },
        ],
      },
      { kind: 'button', label: 'Download', href: appUrl('/notes/purchases') },
      {
        kind: 'paragraph',
        // No link is embedded: download URLs are signed, expire in 120s and
        // identify the buyer (see presignNoteDownload), so mailing one would
        // both break and be traceable to the recipient if forwarded.
        text: 'Download links are generated when you open the page and expire quickly, so please download from your purchases page rather than saving a link.',
      },
    ],
  }),

  noteSold: (p: { nickname: string; title: string; earnedLabel: string }): EmailContent => ({
    subject: 'You sold a note on UniNotes',
    heading: 'You made a sale',
    preheader: `"${p.title}" was purchased.`,
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'callout', tone: 'success', title: 'A student bought your note' },
      {
        kind: 'facts',
        rows: [
          { label: 'Note', value: p.title },
          { label: 'You earned', value: p.earnedLabel },
        ],
      },
      {
        kind: 'paragraph',
        text: 'Earnings clear after the refund window closes, then become available to withdraw.',
      },
      { kind: 'button', label: 'Open wallet', href: appUrl('/wallet') },
    ],
  }),
} satisfies Record<TemplateName, (params: never) => EmailContent>;

/** Renders a template to the subject/html/text triple the transport wants. */
export function buildEmail<K extends TemplateName>(
  name: K,
  params: Parameters<(typeof TEMPLATES)[K]>[0],
): { subject: string; html: string; text: string } {
  const template = TEMPLATES[name] as (p: unknown) => EmailContent;
  const content = template(params);
  const { html, text } = renderEmail(content);
  return { subject: content.subject, html, text };
}
