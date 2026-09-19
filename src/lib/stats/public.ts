import 'server-only';
import { unstable_cache } from 'next/cache';
import { BookingStatus, NoteStatus, UserRole } from '@/lib/enums';
import { adminDb } from '@/lib/firebase/admin';
import { COLLECTIONS } from '@/lib/firebase/collections';
import { UNIVERSITIES } from '@/lib/universities';

/**
 * The landing page's headline numbers, read from live collections.
 *
 * `null` means "could not be read", never zero: the stats row renders it as a
 * dash, because a public page claiming "0 students" during a Firestore blip is
 * worse than admitting it does not know.
 */
export type PublicStats = {
  students: number | null;
  notes: number | null;
  mentorHours: number | null;
  universities: number;
};

/**
 * Cached for 15 minutes across all visitors. The root layout reads cookies, so
 * every page is dynamic and a route-level `revalidate` would not help; without
 * this cache each landing-page view would issue three aggregations.
 *
 * A failed read THROWS inside the cached function, so the failure is not
 * cached and the next request retries instead of showing dashes for 15 minutes.
 */
const readCounts = unstable_cache(
  async () => {
    const db = adminDb();
    const [students, notes, completed] = await Promise.all([
      // Equality-only filters: served by single-field index merging, the same
      // shape the admin dashboard counts use, so no composite index is needed.
      db.collection(COLLECTIONS.users)
        .where('deletedAt', '==', null)
        .where('role', '==', UserRole.STUDENT)
        .count()
        .get(),
      db.collection(COLLECTIONS.notes).where('status', '==', NoteStatus.PUBLISHED).count().get(),
      // Bookings store start/end rather than a duration, so there is no field
      // for a sum() aggregation; a two-field projection keeps the read small.
      db.collection(COLLECTIONS.bookings)
        .where('status', '==', BookingStatus.COMPLETED)
        .select('startsAt', 'endsAt')
        .get(),
    ]);

    const minutes = completed.docs.reduce((total, doc) => {
      const start = doc.get('startsAt')?.toMillis?.();
      const end = doc.get('endsAt')?.toMillis?.();
      return start && end && end > start ? total + (end - start) / 60_000 : total;
    }, 0);

    return {
      students: students.data().count,
      notes: notes.data().count,
      mentorHours: Math.round(minutes / 60),
    };
  },
  ['public-stats'],
  { revalidate: 900 },
);

export async function getPublicStats(): Promise<PublicStats> {
  const universities = UNIVERSITIES.length;
  try {
    return { ...(await readCounts()), universities };
  } catch (error) {
    console.error('[stats/public] read failed', error);
    return { students: null, notes: null, mentorHours: null, universities };
  }
}
