import type { Metadata } from 'next';
import { SettingsView } from '@/components/settings/SettingsView';
import { requirePageSession } from '@/lib/auth/page-guard';

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
};

/** Session state is per-request; this page must never be prerendered or cached. */
export const dynamic = 'force-dynamic';

/**
 * Settings.
 *
 * In production this becomes a Server Component that loads the viewer and
 * passes real data down:
 *
 *   const { userId } = await requireSession();
 *   const data = await db.user.findUniqueOrThrow({ where: { id: userId }, select: {...} });
 *   return <SettingsView initial={data} />;
 *
 * The privacy columns live on `users` (showRealName, showEmail, showPhone,
 * showUniversity, showFaculty, showGraduationYear) as FieldVisibility enums —
 * see prisma/schema.prisma. They are enforced server-side in every profile
 * serialiser; the picker here only records the preference.
 */
export default async function SettingsPage() {
  await requirePageSession('/settings');

  return (
    <main id="main">
      <SettingsView />
    </main>
  );
}
