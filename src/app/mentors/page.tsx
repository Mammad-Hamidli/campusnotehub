import type { Metadata } from 'next';
import { MentorsList } from '@/components/mentors/MentorsList';

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
export default function MentorsPage() {
  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <MentorsList />
    </main>
  );
}
