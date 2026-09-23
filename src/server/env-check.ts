/**
 * Startup configuration check. Reports variable NAMES only - never values.
 *
 * Required: the app cannot authenticate, hash, store or clean up without them.
 * In production a missing one throws, so the instance fails loudly at boot.
 * In development it is logged, so a partial local setup still starts.
 *
 * Degraded: the app runs, but a feature is off (email) or falls back
 * (verification without the doc-verifier goes to human review).
 */
import { MAIL_ACCOUNT, roleMailbox } from '@/lib/email/identity';

type Env = Record<string, string | undefined>;

export function checkEnvironment(env: Env = process.env): { missing: string[]; degraded: string[] } {
  const has = (key: string) => Boolean(env[key]?.trim());
  const missing: string[] = [];
  const degraded: string[] = [];

  for (const key of ['JWT_PRIVATE_KEY_PEM', 'JWT_PUBLIC_KEY_PEM', 'PII_HASH_PEPPER', 'FIREBASE_PROJECT_ID', 'CRON_SECRET', 'APP_URL']) {
    if (!has(key)) missing.push(key);
  }
  if (env.PII_HASH_PEPPER?.startsWith('change-me')) missing.push('PII_HASH_PEPPER (placeholder value)');

  if (!has('FIREBASE_SERVICE_ACCOUNT') && !has('GOOGLE_APPLICATION_CREDENTIALS') && !has('FIRESTORE_EMULATOR_HOST') && !has('K_SERVICE')) {
    missing.push('FIREBASE_SERVICE_ACCOUNT');
  }
  if (!has('CLOUDINARY_URL') && !(has('CLOUDINARY_CLOUD_NAME') && has('CLOUDINARY_API_KEY') && has('CLOUDINARY_API_SECRET'))) {
    missing.push('CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET');
  }

  if (!has('SMTP_PASSWORD')) degraded.push('SMTP_PASSWORD (transactional email disabled)');
  if (!has('IMAP_PASSWORD')) degraded.push('IMAP_PASSWORD (the support mailbox is not being read)');

  /**
   * The platform may only ever send as, or read, its own mailbox. Another
   * address here is not a degraded feature - it is the application about to
   * sign mail as somebody else - so it fails the boot in production alongside
   * the other required variables, rather than warning into a log nobody reads.
   */
  for (const [key, value] of [
    ['EMAIL_FROM', env.EMAIL_FROM],
    ['EMAIL_SUPPORT_ADDRESS', env.EMAIL_SUPPORT_ADDRESS],
    ['SMTP_USER', env.SMTP_USER],
    ['IMAP_USER', env.IMAP_USER],
  ] as const) {
    if (!value?.trim()) continue;
    try {
      roleMailbox(value, key, MAIL_ACCOUNT);
    } catch (error) {
      missing.push(`${key} (${(error as Error).message})`);
    }
  }

  /**
   * Social sign-in providers are optional, but HALF a provider is a mistake:
   * its button silently disappears (see providerConfig), which reads as "the
   * feature broke" rather than "a variable is missing".
   */
  for (const [provider, keys] of [['Google', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']]] as const) {
    const set = keys.filter(has);
    if (set.length > 0 && set.length < keys.length) {
      degraded.push(`${keys.filter((k) => !has(k)).join(' / ')} (${provider} sign-in is disabled)`);
    }
  }

  if (!has('DOC_VERIFIER_URL') || !has('DOC_VERIFIER_TOKEN')) {
    degraded.push('DOC_VERIFIER_URL / DOC_VERIFIER_TOKEN (every submission goes to human review)');
  }

  if (degraded.length) console.warn(`[env] Degraded configuration: ${degraded.join('; ')}`);
  if (missing.length) {
    const message = `[env] Missing required configuration: ${missing.join(', ')}`;
    if (env.NODE_ENV === 'production') throw new Error(message);
    console.error(message);
  }
  return { missing, degraded };
}
