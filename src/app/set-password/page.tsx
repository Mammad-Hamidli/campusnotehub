import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SET_PASSWORD_PATH, requirePageSession } from '@/lib/auth/page-guard';
import { SetPasswordForm } from '@/components/auth/SetPasswordForm';

export const metadata: Metadata = { title: 'Set a password', robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

/**
 * /set-password - where a Google-only account lands when it owes its first
 * local password (see the OAuth callback). Every other protected page
 * redirects here until it is set; anyone who owes nothing is sent on.
 */
export default async function SetPasswordPage() {
  const viewer = await requirePageSession(SET_PASSWORD_PATH);
  if (!viewer.passwordSetupRequired) redirect('/dashboard');

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-12">
      <SetPasswordForm />
    </main>
  );
}
