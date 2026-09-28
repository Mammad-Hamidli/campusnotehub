import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { MENTOR_DASHBOARD_PATH } from '@/lib/site';
import { RegisterAside } from '@/components/register/RegisterAside';
import { MentorSignupForm } from '@/components/mentors/MentorSignupForm';

export const metadata: Metadata = {
  title: 'Become a mentor',
  // A credentials form, like /register.
  robots: { index: false, follow: false },
};

/** The signed-in check reads live session state, so nothing here is cacheable. */
export const dynamic = 'force-dynamic';

/**
 * Mentor signup. Reached from the "I'm a mentor" button on /register,
 * /register?as=mentor, the guest state of /mentors/apply, and every request to
 * the mentors subdomain (see the middleware).
 *
 * A signed-in visitor never gets a second account from here: a mentor goes to
 * the panel, anyone else to /mentors/apply - becoming a mentor from an
 * existing account is an application, not a signup. Checked with getViewer()
 * (live session row), for the reason given on /login.
 */
export default async function MentorJoinPage() {
  const viewer = await getViewer();
  if (viewer) redirect(can(viewer, 'mentors:console') ? MENTOR_DASHBOARD_PATH : '/mentors/apply');

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <RegisterAside variant="mentor" />

      <main id="main" className="flex flex-1 items-start justify-center px-4 py-10 sm:px-8 lg:py-16">
        <MentorSignupForm />
      </main>
    </div>
  );
}
