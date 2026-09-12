/**
 * Everything about the email shell that is a BUSINESS fact rather than a
 * layout decision: who is sending, where they are, how to reach them, and
 * where the images come from.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT LITERALS IN THE LAYOUT
 * ---------------------------------------------------------------------------
 * The company name used to be hardcoded in three places in layout.ts, and it
 * had already drifted: the layout signed every message "UniPath" while
 * EMAIL_FROM introduced them as "CampusHub", so a recipient saw two different
 * brands in one email. One resolved object removes the possibility.
 *
 * Every value has a working default, so a deployment that sets none of these
 * still sends correct, branded mail. Nothing here is a secret - it is all
 * printed in the footer of every message - so these are plain env vars and are
 * safe to log.
 */

import { appUrl } from './urls';

export type EmailAssetMode = 'cid' | 'url';

export type EmailBranding = {
  companyName: string;
  companyAddress: string;
  supportEmail: string;
  unsubscribeUrl: string;
  /** How image `src` attributes are produced. See src/lib/email/assets.ts. */
  assetMode: EmailAssetMode;
  /** Filesystem directory holding the images, for `cid` mode. */
  assetDir: string;
  /** Public base URL for the images, for `url` mode. No trailing slash. */
  assetBaseUrl: string;
  /** Footer social links. A link is rendered only when its URL is set. */
  social: { label: string; url: string; icon: string }[];
};

const trim = (value: string | undefined) => value?.trim() || undefined;

/**
 * Resolved per call rather than frozen at module load.
 *
 * The preview route and the test suite both set these variables in-process to
 * render variants, and a module-level constant would capture whatever the
 * environment happened to be when the first email module was imported.
 */
export function emailBranding(): EmailBranding {
  const companyName = trim(process.env.EMAIL_COMPANY_NAME) ?? 'CampusHub';

  /**
   * Falls back to the authenticated mailbox, because that address is
   * guaranteed to exist and to be monitored - several templates tell the
   * reader to "reply to support", and a reply-to nobody reads is worse than
   * no invitation to reply at all.
   */
  const supportEmail =
    trim(process.env.EMAIL_SUPPORT_ADDRESS) ??
    trim(process.env.GMAIL_USER) ??
    trim(process.env.SMTP_USER) ??
    'support@campushub.az';

  const assetMode: EmailAssetMode = process.env.EMAIL_ASSET_MODE === 'url' ? 'url' : 'cid';

  const social = [
    { label: 'Facebook', url: trim(process.env.EMAIL_SOCIAL_FACEBOOK_URL), icon: 'icon-facebook.png' },
    { label: 'Instagram', url: trim(process.env.EMAIL_SOCIAL_INSTAGRAM_URL), icon: 'icon-instagram.png' },
    { label: 'LinkedIn', url: trim(process.env.EMAIL_SOCIAL_LINKEDIN_URL), icon: 'icon-linkedin.png' },
  ].filter((entry): entry is { label: string; url: string; icon: string } => Boolean(entry.url));

  return {
    companyName,
    companyAddress: trim(process.env.EMAIL_COMPANY_ADDRESS) ?? 'Baku, Azerbaijan',
    supportEmail,
    /**
     * Defaults to the notification settings page rather than a one-click
     * unsubscribe endpoint, which does not exist: every message the platform
     * sends is transactional (a decision about your account, your money or
     * your upload), and there is no marketing list to leave. The footer says
     * exactly that, so the link and the sentence agree.
     */
    unsubscribeUrl: trim(process.env.EMAIL_UNSUBSCRIBE_URL) ?? appUrl('/settings'),
    assetMode,
    assetDir: trim(process.env.EMAIL_ASSET_DIR) ?? 'public/email',
    assetBaseUrl: (trim(process.env.EMAIL_ASSET_BASE_URL) ?? appUrl('/email')).replace(/\/+$/, ''),
    social,
  };
}
