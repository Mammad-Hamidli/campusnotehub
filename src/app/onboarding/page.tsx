import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requirePageSession } from '@/lib/auth/page-guard';
import { findTakenUsernames, findUserById } from '@/lib/firebase/repositories/users';
import { isPlaceholderEmail } from '@/lib/auth/username';
import { suggestNickname } from '@/lib/auth/nickname-suggestion';
import { RegisterAside } from '@/components/register/RegisterAside';
import { OnboardingForm } from '@/components/onboarding/OnboardingForm';

export const metadata: Metadata = { title: 'Complete your profile', robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

/**
 * /onboarding - where a first quick login (Google) lands.
 *
 * The account already exists, signed in, but view-only with a temporary
 * "user34232" handle. Anyone whose profile is already complete is sent on to
 * the dashboard, so this page can never rename an established account.
 *
 * The nickname box starts with a free handle made from the name Google gave
 * (nickname-suggestion.ts). A failed lookup just leaves it empty.
 */
export default async function OnboardingPage() {
  const viewer = await requirePageSession('/onboarding');
  const user = await findUserById(viewer.id);
  if (!user || user.profileIncomplete !== true) redirect('/dashboard');

  const suggestedNickname = await suggestNickname(user, findTakenUsernames).catch(() => null);

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <RegisterAside />
      <main id="main" className="flex flex-1 items-start justify-center px-4 py-10 sm:px-8 lg:py-16">
        <OnboardingForm
          temporaryHandle={user.nickname}
          initialName={user.fullName}
          initialNickname={suggestedNickname ?? ''}
          needsEmail={isPlaceholderEmail(user.email)}
        />
      </main>
    </div>
  );
}
