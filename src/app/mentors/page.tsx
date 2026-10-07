import type { Metadata } from 'next';
import { MentorsList } from '@/components/mentors/MentorsList';
import { getViewer } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'PocketMentor' };

/** The directory reflects live approval state, so it is never prerendered. */
export const dynamic = 'force-dynamic';

/**
 * Replaces the previous StubPage.
 *
 * Deliberately NOT behind the session guard: `mentors:browse` is open to
 * signed-out visitors in the capability table, because a directory nobody can
 * see until they sign up cannot attract the students it exists for. Booking is
 * the gated action, and it is gated server-side.
 */
export default async function MentorsPage() {
  // The root layout already made this (memoised) read; a guest's Back goes home.
  const viewer = await getViewer();
  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <MentorsList backHref={viewer ? '/dashboard' : '/'} />
    </main>
  );
}
