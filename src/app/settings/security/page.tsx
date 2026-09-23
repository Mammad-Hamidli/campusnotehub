import type { Metadata } from 'next';
import { TwoFactorPanel } from '@/components/settings/TwoFactorPanel';
import { LinkedAccountsPanel } from '@/components/settings/LinkedAccountsPanel';
import { EmailPanel } from '@/components/settings/EmailPanel';
import { PasswordPanel } from '@/components/settings/PasswordPanel';
import { requirePageSession } from '@/lib/auth/page-guard';

export const metadata: Metadata = {
  title: 'Security',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Two-factor authentication settings. Also where staff are sent when the MFA
 * gate in requireSession withholds their role (see the admin layout).
 */
export default async function SecuritySettingsPage() {
  await requirePageSession('/settings/security');

  return (
    <main id="main">
      <TwoFactorPanel />
      <PasswordPanel />
      <EmailPanel />
      {/* Renders nothing until at least one provider is configured. */}
      <LinkedAccountsPanel />
    </main>
  );
}
