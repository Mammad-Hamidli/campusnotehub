import type { Metadata } from 'next';
import { MentorProfile } from '@/components/mentors/MentorProfile';

export const metadata: Metadata = { title: 'Mentor' };

/** Approval state is live, so this is never prerendered. */
export const dynamic = 'force-dynamic';

/**
 * One mentor's public profile.
 *
 * Not behind the session guard, matching the directory: `mentors:browse` is
 * open to signed-out visitors in the capability table. Booking is the gated
 * action, and it is gated server-side in the booking endpoint - this page only
 * chooses which control to render from what the API reports.
 */
export default async function MentorProfilePage({
  params,
}: {
  params: Promise<{ mentorId: string }>;
}) {
  const { mentorId } = await params;

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <MentorProfile mentorId={mentorId} />
    </main>
  );
}
