/**
 * Representative parameters for every template, in one typed map.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN THE TEST FILE
 * ---------------------------------------------------------------------------
 * Two things need sample data - the dev preview route and the render test - and
 * when each kept its own copy they drifted: the preview showed a template with
 * fields the real caller does not pass, so it "looked fine" while production
 * mail was missing a row. One map, imported by both, cannot do that.
 *
 * The `satisfies` clause is the load-bearing part. It type-checks every entry
 * against the real parameter type of its template, so adding a template
 * without sample data, or changing a template's parameters without updating
 * the sample, is a COMPILE error rather than a runtime surprise in a preview.
 */

import { TEMPLATES, type TemplateName } from './templates';

type SampleMap = { [K in TemplateName]: Parameters<(typeof TEMPLATES)[K]>[0] };

export const SAMPLE_PARAMS = {
  welcome: { nickname: 'aysel', university: 'ADA University', faculty: 'Computer Science' },
  verificationSubmitted: { nickname: 'aysel' },
  verificationApproved: { nickname: 'aysel' },
  verificationRejected: {
    nickname: 'aysel',
    reason: 'The photo was too blurry to read the student number.',
    canResubmit: true,
  },
  accountFrozen: {
    nickname: 'aysel',
    until: '2026-10-01',
    reason: 'Reported for spam in the feed; under review.',
  },
  accountUnfrozen: { nickname: 'aysel' },
  roleAssigned: { nickname: 'aysel', role: 'MENTOR' },
  noteUploaded: { nickname: 'aysel', title: 'Alqoritmlər - tam semestr konspekti' },
  notePurchased: {
    nickname: 'aysel',
    title: 'Alqoritmlər - tam semestr konspekti',
    priceLabel: '5.00 AZN',
  },
  noteSold: {
    nickname: 'aysel',
    title: 'Alqoritmlər - tam semestr konspekti',
    earnedLabel: '4.25 AZN',
  },
  newDeviceLogin: { nickname: 'aysel', device: 'Chrome on Windows', when: '12 Sep 2026, 17:04' },
  profileUpdated: { nickname: 'aysel', fields: ['headline', 'bio'] },
  passwordChanged: { nickname: 'aysel' },
  passwordReset: { nickname: 'aysel' },
  passwordResetLink: { nickname: 'aysel', url: 'https://campushub.com/reset-password#token=example', minutes: 30 },
  mfaEnabled: { nickname: 'aysel', replaced: false },
  mfaDisabled: { nickname: 'aysel', byAdmin: false },
  mfaRecoveryCodeUsed: { nickname: 'aysel', remaining: 9 },
  mfaRecoveryCodesRegenerated: { nickname: 'aysel' },
  oauthLinked: { nickname: 'aysel', provider: 'Google', automatic: false },
  oauthUnlinked: { nickname: 'aysel', provider: 'Google' },
  emailVerification: { nickname: 'aysel', url: 'https://campushub.com/confirm-email#token=example' },
  accountSuspended: {
    nickname: 'aysel',
    level: 'suspended',
    reason: 'Repeated reports from other students.',
  },
  accountReactivated: { nickname: 'aysel' },
  accountDeleted: { nickname: 'aysel' },
  accountDeletionRequested: { nickname: 'aysel' },
  accountDeletionRejected: {
    nickname: 'aysel',
    reason: 'Your wallet still holds 12.50 AZN. Withdraw it first so it is not lost.',
  },
  newNotification: {
    nickname: 'aysel',
    title: 'Someone replied to your post',
    body: 'Nigar commented: "Bu konspekt çox faydalıdır, təşəkkürlər!"',
    linkUrl: '/notifications',
  },
  mentorApplicationSubmitted: { nickname: 'aysel' },
  mentorApplicationApproved: { nickname: 'aysel', profileUrl: '/mentors/abc123' },
  mentorApplicationRejected: {
    nickname: 'aysel',
    reason: 'Please add more detail about your work experience.',
  },
  balanceToppedUp: { nickname: 'aysel', amountLabel: '10.00 AZN', balanceLabel: '34.50 AZN' },
  noteApproved: { nickname: 'aysel', title: 'Alqoritmlər - tam semestr konspekti' },
  noteRejected: {
    nickname: 'aysel',
    title: 'Alqoritmlər - tam semestr konspekti',
    reason: 'Pages 4 to 9 are unreadable.',
  },
} satisfies SampleMap;

/** Every template name, for iterating in the preview route and the tests. */
export const SAMPLE_NAMES = Object.keys(SAMPLE_PARAMS) as TemplateName[];
