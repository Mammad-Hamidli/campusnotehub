import { appUrl, renderEmail, type EmailContent } from './layout';
import type { EmailAttachment } from './assets';

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
  | 'newDeviceLogin'
  | 'profileUpdated'
  | 'passwordChanged'
  | 'passwordReset'
  | 'passwordResetLink'
  | 'mfaEnabled'
  | 'mfaDisabled'
  | 'mfaRecoveryCodeUsed'
  | 'mfaRecoveryCodesRegenerated'
  | 'oauthLinked'
  | 'oauthUnlinked'
  | 'emailVerification'
  | 'accountSuspended'
  | 'accountReactivated'
  | 'accountDeleted'
  | 'accountDeletionRequested'
  | 'accountDeletionRejected'
  | 'newNotification'
  | 'mentorApplicationSubmitted'
  | 'mentorApplicationApproved'
  | 'mentorApplicationRejected'
  | 'noteApproved'
  | 'noteRejected'
  | 'followRequest'
  | 'emailChangeConfirm'
  | 'emailChangeRequested'
  | 'emailChanged';

/** Greeting line. Nickname, never the legal name - see the User model. */
const hi = (nickname: string) => `Hi @${nickname},`;

/** Friendly names for the profile fields PATCH /api/me can change. */
const PROFILE_FIELD_LABELS: Record<string, string> = {
  fullName: 'Name',
  headline: 'Headline',
  bio: 'Bio',
  locale: 'Language',
  timezone: 'Time zone',
  facultySlug: 'Faculty',
  showRealName: 'Privacy settings',
  showEmail: 'Privacy settings',
  showPhone: 'Privacy settings',
  showUniversity: 'Privacy settings',
  showFaculty: 'Privacy settings',
  showGraduationYear: 'Privacy settings',
};

export const TEMPLATES = {
  welcome: (p: { nickname: string; university?: string | null; faculty?: string | null }): EmailContent => ({
    subject: 'Welcome to UniPath',
    heading: 'Your account is ready',
    preheader: 'Verify your student status to unlock mentoring and your verified badge.',
    blocks: [
      // Hero: opt-in, and this is one of the three messages that earns one.
      // See the 'hero' block comment in layout.ts for why the account and
      // security templates deliberately do not carry an image.
      { kind: 'hero', image: 'hero.jpg', alt: 'Students on campus' },
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
        body: 'Until you are verified you can post, share notes and follow people, but you cannot book or offer mentoring.',
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
    preheader: 'Mentoring is now unlocked, and your verified badge is live.',
    blocks: [
      { kind: 'hero', image: 'hero.jpg', alt: 'Verified student account' },
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'callout', tone: 'success', title: 'Your student status is confirmed' },
      {
        kind: 'paragraph',
        text: 'You can now book and offer mentoring sessions. Your verified badge is visible next to your handle.',
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
        text: 'You can still sign in, read the feed, and browse notes and mentors. Posting, sharing and bookings are paused for the duration.',
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

  newDeviceLogin: (p: { nickname: string; device: string; when: string }): EmailContent => ({
    subject: 'New sign-in to your UniPath account',
    heading: 'New device signed in',
    preheader: 'Your account was just signed in to from a device we have not seen before.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'paragraph', text: 'Your account was just signed in to from a new device.' },
      {
        kind: 'facts',
        rows: [
          { label: 'Device', value: p.device },
          { label: 'Time', value: p.when },
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Was this not you?',
        body: 'Contact support right away so we can end the session and secure your account.',
      },
      { kind: 'button', label: 'Open settings', href: appUrl('/settings') },
    ],
  }),

  profileUpdated: (p: { nickname: string; fields: string[] }): EmailContent => {
    const changed = [...new Set(p.fields.map((f) => PROFILE_FIELD_LABELS[f] ?? f))];
    return {
      subject: 'Your UniPath profile was updated',
      heading: 'Profile updated',
      preheader: 'Changes were saved to your profile.',
      blocks: [
        { kind: 'paragraph', text: hi(p.nickname) },
        { kind: 'paragraph', text: 'The following changes were saved to your profile.' },
        { kind: 'facts', rows: [{ label: 'Changed', value: changed.join(', ') || '-' }] },
        {
          kind: 'callout',
          tone: 'neutral',
          title: 'Did not make this change?',
          body: 'Contact support so we can secure your account.',
        },
        { kind: 'button', label: 'Open settings', href: appUrl('/settings') },
      ],
    };
  },

  passwordChanged: (p: { nickname: string; viaReset?: boolean }): EmailContent => ({
    subject: 'Your UniPath password was changed',
    heading: 'Password changed',
    preheader: 'The password on your account was just changed.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: p.viaReset
          ? 'The password on your UniPath account was just reset with a link sent to this address. Every session was signed out.'
          : 'The password on your UniPath account was just changed. Every other session was signed out.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Did not change it?',
        body: 'Contact support immediately - someone else may have access to your account.',
      },
    ],
  }),

  oauthLinked: (p: { nickname: string; provider: string; automatic: boolean }): EmailContent => ({
    subject: `${p.provider} can now sign in to your UniPath account`,
    heading: `${p.provider} connected`,
    preheader: `Your account can now be opened with ${p.provider}.`,
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: p.automatic
          ? `You signed in with ${p.provider} using the same verified email address as your account, so it was connected automatically. From now on you can sign in with ${p.provider}.`
          : `A ${p.provider} account was just connected to your UniPath account. From now on it can be used to sign in.`,
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Was this not you?',
        body: `Remove ${p.provider} in your security settings and contact support immediately.`,
      },
      { kind: 'button', label: 'Review security settings', href: appUrl('/settings/security') },
    ],
  }),

  emailVerification: (p: { nickname: string; url: string }): EmailContent => ({
    subject: 'Confirm your email address for UniPath',
    heading: 'Confirm your email',
    preheader: 'One click, while signed in, confirms this address belongs to you.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: 'Please confirm that this address belongs to you. Open the link in the browser where you are signed in to your account - it only works there. The link expires in 24 hours.',
      },
      { kind: 'button', label: 'Confirm my email', href: p.url },
      {
        kind: 'callout',
        tone: 'neutral',
        title: 'Did not create an account?',
        body: 'Ignore this email. Nothing happens unless someone signed in to that account opens the link, and nobody else can use it.',
      },
    ],
  }),

  passwordResetLink: (p: { nickname: string; url: string; minutes: number }): EmailContent => ({
    subject: 'Reset your UniPath password',
    heading: 'Reset your password',
    preheader: `Someone asked to reset the password on your account. The link works for ${p.minutes} minutes.`,
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: `We received a request to reset the password on your UniPath account. The link below works once, for ${p.minutes} minutes. Opening it signs out every device that is signed in to your account once the new password is saved.`,
      },
      { kind: 'button', label: 'Choose a new password', href: p.url },
      {
        kind: 'callout',
        tone: 'neutral',
        title: 'Did not ask for this?',
        body: 'Ignore this email - your password stays as it is and the link expires on its own. Never forward it: anyone holding it can set a new password.',
      },
    ],
  }),

  oauthUnlinked: (p: { nickname: string; provider: string }): EmailContent => ({
    subject: `${p.provider} was disconnected from your UniPath account`,
    heading: `${p.provider} disconnected`,
    preheader: `Your account can no longer be opened with ${p.provider}.`,
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'paragraph', text: `${p.provider} can no longer be used to sign in to your account.` },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Was this not you?',
        body: 'Contact support immediately - someone else may have access to your account.',
      },
      { kind: 'button', label: 'Review security settings', href: appUrl('/settings/security') },
    ],
  }),

  mfaEnabled: (p: { nickname: string; replaced: boolean }): EmailContent => ({
    subject: p.replaced
      ? 'Your UniPath authenticator was replaced'
      : 'Two-factor authentication is on for your UniPath account',
    heading: p.replaced ? 'Authenticator replaced' : 'Two-factor authentication enabled',
    preheader: 'A new authenticator app now protects your account.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: p.replaced
          ? 'A new authenticator app was just set up for your account. The previous one no longer works, your old recovery codes were replaced, and every other session was signed out.'
          : 'Two-factor authentication was just turned on. Signing in now needs your password and a code from your authenticator app. Every other session was signed out.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Was this not you?',
        body: 'Someone may know your password. Contact support immediately so we can lock the account.',
      },
      { kind: 'button', label: 'Review security settings', href: appUrl('/settings/security') },
    ],
  }),

  mfaDisabled: (p: { nickname: string; byAdmin: boolean }): EmailContent => ({
    subject: 'Two-factor authentication was turned off for your UniPath account',
    heading: 'Two-factor authentication disabled',
    preheader: 'Your account is now protected by your password alone.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: p.byAdmin
          ? 'An administrator removed two-factor authentication from your account at your request, and every session was signed out. Set it up again after you sign in.'
          : 'Two-factor authentication was just turned off. Your account is now protected by your password alone, and every other session was signed out.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Was this not you?',
        body: 'Contact support immediately - someone else may have access to your account.',
      },
      { kind: 'button', label: 'Review security settings', href: appUrl('/settings/security') },
    ],
  }),

  mfaRecoveryCodeUsed: (p: { nickname: string; remaining: number }): EmailContent => ({
    subject: 'A recovery code was used to sign in to UniPath',
    heading: 'Recovery code used',
    preheader: 'One of your recovery codes was just used instead of your authenticator.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: 'Someone signed in to your account with one of your recovery codes instead of an authenticator code. That code cannot be used again.',
      },
      { kind: 'facts', rows: [{ label: 'Codes left', value: String(p.remaining) }] },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Was this not you?',
        body: 'Your recovery codes may have been exposed. Contact support immediately.',
      },
      { kind: 'button', label: 'Review security settings', href: appUrl('/settings/security') },
    ],
  }),

  mfaRecoveryCodesRegenerated: (p: { nickname: string }): EmailContent => ({
    subject: 'New UniPath recovery codes were generated',
    heading: 'Recovery codes replaced',
    preheader: 'Your previous recovery codes no longer work.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: 'A new set of recovery codes was just generated for your account. Every earlier code has stopped working.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Was this not you?',
        body: 'Contact support immediately - someone else may have access to your account.',
      },
    ],
  }),

  passwordReset: (p: { nickname: string }): EmailContent => ({
    subject: 'Your UniPath password was reset',
    heading: 'Password reset',
    preheader: 'An administrator reset the password on your account.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: 'The password on your UniPath account was reset by an administrator, and every active session was signed out. Sign in with the new password you were given.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Did not request this?',
        body: 'Contact support right away.',
      },
      { kind: 'button', label: 'Sign in', href: appUrl('/login') },
    ],
  }),

  accountSuspended: (p: {
    nickname: string;
    level: 'suspended' | 'banned' | 'restricted';
    reason?: string | null;
  }): EmailContent => ({
    subject:
      p.level === 'banned'
        ? 'Your UniPath account has been suspended'
        : p.level === 'restricted'
          ? 'Your UniPath account has been restricted'
          : 'Your UniPath account has been suspended',
    heading: p.level === 'restricted' ? 'Account restricted' : 'Account suspended',
    preheader: 'A moderator changed the status of your account.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text:
          p.level === 'restricted'
            ? 'Some features of your account have been restricted by a moderator.'
            : p.level === 'banned'
              ? 'Your account has been suspended by a moderator and you can no longer sign in.'
              : 'Your account has been suspended by a moderator. You can browse, but posting, sharing and bookings are paused.',
      },
      ...(p.reason ? [{ kind: 'facts' as const, rows: [{ label: 'Reason', value: p.reason }] }] : []),
      {
        kind: 'callout',
        tone: 'neutral',
        title: 'Think this is a mistake?',
        body: 'Reply to this email or contact support with your handle and we will review it.',
      },
    ],
  }),

  accountReactivated: (p: { nickname: string }): EmailContent => ({
    subject: 'Your UniPath account is active again',
    heading: 'Account reactivated',
    preheader: 'Your account has been restored.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'paragraph', text: 'Your account has been reactivated. Everything is available again.' },
      { kind: 'button', label: 'Open UniPath', href: appUrl('/dashboard') },
    ],
  }),

  accountDeleted: (p: { nickname: string }): EmailContent => ({
    subject: 'Your UniPath account was deleted',
    heading: 'Account deleted',
    preheader: 'Your account has been deleted.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: 'Your UniPath account has been deleted and every session was signed out. You will not receive further emails about it.',
      },
      {
        kind: 'callout',
        tone: 'neutral',
        title: 'Did not expect this?',
        body: 'Contact support and include your handle.',
      },
    ],
  }),

  accountDeletionRequested: (p: { nickname: string }): EmailContent => ({
    subject: 'We received your account deletion request',
    heading: 'Deletion request received',
    preheader: 'An administrator will review your request.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: 'We received your request to delete your UniPath account. An administrator will review it, and we will email you when it has been processed. Your account keeps working until then.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Did not request this?',
        body: 'Cancel the request in Settings and change your password - someone else may have access to your account.',
      },
      { kind: 'button', label: 'Open settings', href: appUrl('/settings?tab=account') },
    ],
  }),

  accountDeletionRejected: (p: { nickname: string; reason: string }): EmailContent => ({
    subject: 'Your account deletion request was not processed',
    heading: 'Deletion request declined',
    preheader: 'Your account was not deleted.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: 'An administrator reviewed your request to delete your UniPath account and could not process it yet. Your account is still active.',
      },
      { kind: 'facts', rows: [{ label: 'Reason', value: p.reason }] },
      {
        kind: 'callout',
        tone: 'neutral',
        title: 'What next?',
        body: 'Once the issue above is resolved you can file a new request in Settings, or reply to this email.',
      },
      { kind: 'button', label: 'Open settings', href: appUrl('/settings?tab=account') },
    ],
  }),

  newNotification: (p: { nickname: string; title: string; body?: string | null; linkUrl?: string | null }): EmailContent => ({
    subject: p.title,
    heading: p.title,
    preheader: p.body || 'You have a new notification on UniPath.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      ...(p.body ? [{ kind: 'paragraph' as const, text: p.body }] : []),
      { kind: 'button', label: 'Open', href: appUrl(p.linkUrl || '/notifications') },
    ],
  }),

  mentorApplicationSubmitted: (p: { nickname: string }): EmailContent => ({
    subject: 'We received your mentor application',
    heading: 'Application received',
    preheader: 'A moderator will review your PocketMentor application.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: 'Thanks for applying to mentor on PocketMentor. A moderator reviews every application; you will get an email with the decision.',
      },
      { kind: 'button', label: 'Check status', href: appUrl('/mentors/apply') },
    ],
  }),

  mentorApplicationApproved: (p: { nickname: string; profileUrl: string }): EmailContent => ({
    subject: 'You are now a PocketMentor mentor',
    heading: 'Application approved',
    preheader: 'Your mentor profile is live.',
    blocks: [
      { kind: 'hero', image: 'hero.jpg', alt: 'Approved PocketMentor mentor' },
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'paragraph', text: 'Your mentor application was approved and your profile is now listed in PocketMentor.' },
      { kind: 'button', label: 'View my profile', href: appUrl(p.profileUrl) },
    ],
  }),

  mentorApplicationRejected: (p: { nickname: string; reason?: string | null }): EmailContent => ({
    subject: 'Your mentor application was not approved',
    heading: 'Application not approved',
    preheader: 'A moderator reviewed your PocketMentor application.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'paragraph', text: 'A moderator reviewed your mentor application and could not approve it this time.' },
      ...(p.reason ? [{ kind: 'facts' as const, rows: [{ label: 'Reason', value: p.reason }] }] : []),
      { kind: 'paragraph', text: 'You can update your details and apply again.' },
      { kind: 'button', label: 'Apply again', href: appUrl('/mentors/apply') },
    ],
  }),

  noteApproved: (p: { nickname: string; title: string }): EmailContent => ({
    subject: 'Your note is published: ' + p.title,
    heading: 'Note approved',
    preheader: 'Your note is now listed in UniNotes.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'paragraph', text: 'Your note "' + p.title + '" was approved and is now listed in UniNotes.' },
      { kind: 'button', label: 'View UniNotes', href: appUrl('/notes') },
    ],
  }),

  noteRejected: (p: { nickname: string; title: string; reason?: string | null }): EmailContent => ({
    subject: 'Your note was not approved: ' + p.title,
    heading: 'Note not approved',
    preheader: 'A moderator reviewed your note.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'paragraph', text: 'A moderator reviewed "' + p.title + '" and could not approve it.' },
      ...(p.reason ? [{ kind: 'facts' as const, rows: [{ label: 'Reason', value: p.reason }] }] : []),
      { kind: 'button', label: 'Upload a new version', href: appUrl('/notes/new') },
    ],
  }),

  followRequest: (p: { nickname: string; requester: string; url: string }): EmailContent => ({
    subject: `@${p.requester} wants to follow you on UniPath`,
    heading: 'New follow request',
    preheader: `@${p.requester} asked to follow you. Accept or decline in the app.`,
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'paragraph', text: `@${p.requester} sent you a follow request. Nothing is shared until you accept it.` },
      { kind: 'button', label: 'Review the request', href: p.url },
    ],
  }),

  emailChangeConfirm: (p: { nickname: string; url: string; minutes: number }): EmailContent => ({
    subject: 'Confirm your new email address for UniPath',
    heading: 'Confirm your new email',
    preheader: `Confirm this address to finish moving your account to it. The link works for ${p.minutes} minutes.`,
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      {
        kind: 'paragraph',
        text: `You asked to move your UniPath account to this address. Open the link in the browser where you are signed in - it only works there, once, for ${p.minutes} minutes.`,
      },
      { kind: 'button', label: 'Confirm new email', href: p.url },
      {
        kind: 'callout',
        tone: 'neutral',
        title: 'Did not ask for this?',
        body: 'Ignore this email. The account keeps its current address unless someone signed in to it opens the link.',
      },
    ],
  }),

  emailChangeRequested: (p: { nickname: string; newEmail: string }): EmailContent => ({
    subject: 'An email change was requested on your UniPath account',
    heading: 'Email change requested',
    preheader: 'Someone signed in to your account asked to move it to a new address.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'facts', rows: [{ label: 'New address', value: p.newEmail }] },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Was this not you?',
        body: 'Change your password and sign out other devices in Settings. The change only completes when the new address confirms it.',
      },
    ],
  }),

  emailChanged: (p: { nickname: string; newEmail: string }): EmailContent => ({
    subject: 'Your UniPath email address was changed',
    heading: 'Email address changed',
    preheader: 'Your account now signs in and receives mail at a new address.',
    blocks: [
      { kind: 'paragraph', text: hi(p.nickname) },
      { kind: 'facts', rows: [{ label: 'New address', value: p.newEmail }] },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Was this not you?',
        body: 'Contact support right away. This is the last message sent to this address about the account.',
      },
    ],
  }),
} satisfies Record<TemplateName, (params: never) => EmailContent>;

/**
 * Renders a template to what the transport needs.
 *
 * `attachments` carries the inline images in CID mode and is empty otherwise.
 * It is produced HERE, at send time, rather than stored anywhere: the email
 * outbox persists only `to`, `template` and `params`, so a retry re-reads the
 * image files from disk and no Buffer ever goes into Firestore.
 */
export function buildEmail<K extends TemplateName>(
  name: K,
  params: Parameters<(typeof TEMPLATES)[K]>[0],
): { subject: string; html: string; text: string; attachments: EmailAttachment[] } {
  const template = TEMPLATES[name] as (p: unknown) => EmailContent;
  const content = template(params);
  const { html, text, attachments } = renderEmail(content);
  return { subject: content.subject, html, text, attachments };
}
