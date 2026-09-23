import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/session';
import { UserRole } from '@/lib/enums';
import { RegisterAside } from '@/components/register/RegisterAside';
import { RegisterForm } from '@/components/register/RegisterForm';
import { enabledProviders } from '@/lib/auth/oauth/providers';

export const metadata: Metadata = {
  title: 'Qeydiyyat',
  // A credentials form. Keep it out of every index, including link previews.
  robots: { index: false, follow: false },
};

/** The signed-in check below reads live session state, so nothing here is cacheable. */
export const dynamic = 'force-dynamic';

/**
 * Two-pane registration: the aside (logo, language, why we verify) and the
 * single-step form. The aside collapses to a compact strip on mobile.
 */
export default async function RegisterPage() {
  /**
   * The middleware used to bounce a signed-in visitor away from here on the
   * strength of the JWT signature alone. It cannot see a revoked session, so
   * that check moved to where live account state is readable - the same change
   * made on /login, and for the same reason. A visitor whose session is merely
   * REVOKED must reach the form, not be redirected into an app they have
   * signed out of.
   */
  const viewer = await getViewer();
  if (viewer) {
    redirect(
      viewer.role === UserRole.ADMIN || viewer.role === UserRole.MODERATOR
        ? '/admin'
        : '/dashboard',
    );
  }

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <RegisterAside />

      <main id="main" className="flex flex-1 items-start justify-center px-4 py-10 sm:px-8 lg:py-16">
        {/* Only providers whose credentials are configured get a button. */}
        <RegisterForm providers={enabledProviders()} />
      </main>
    </div>
  );
}
