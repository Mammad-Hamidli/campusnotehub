import type { Metadata } from 'next';
import { SettingsView } from '@/components/settings/SettingsView';

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
};

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
export default function SettingsPage() {
  return (
    <main id="main">
      <SettingsView />
    </main>
  );
}
