import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getViewer } from '@/lib/auth/session';
import { can } from '@/lib/permissions';
import { usernameKey } from '@/lib/auth/username';
import { LOCALE_COOKIE } from '@/lib/i18n/dictionaries';
import { loadPublicProfile } from '@/lib/profile/public';
import { PublicProfileView } from '@/components/profile/PublicProfileView';

/** Follow state and counts are live, so this is never prerendered. */
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ nickname: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { nickname } = await params;
  return { title: `@${decodeURIComponent(nickname)}` };
}

/**
 * Someone's profile - where a click on a name or picture in the feed (Lent)
 * lands.
 *
 * Rendered on the server straight from the repositories (no API hop), with
 * the same projection GET /api/users/[nickname] returns, so privacy settings
 * are applied in exactly one place (src/lib/profile/public.ts). Readable
 * signed out, like the feed itself; following is the gated action and is
 * enforced by POST /api/users/[nickname]/follow.
 */
export default async function PublicProfilePage({ params }: Params) {
  const { nickname } = await params;
  const key = usernameKey(decodeURIComponent(nickname));
  if (!key) notFound();

  const [viewer, jar] = await Promise.all([getViewer(), cookies()]);
  const profile = await loadPublicProfile(key, viewer, {
    canFollow: can(viewer, 'users:follow'),
    locale: jar.get(LOCALE_COOKIE)?.value,
  });
  if (!profile) notFound();

  return (
    <main id="main" className="min-h-dvh bg-surface-muted">
      <PublicProfileView
        profile={profile}
        viewerId={viewer?.id ?? null}
        signedIn={Boolean(viewer)}
        viewOnly={Boolean(viewer?.profileIncomplete)}
      />
    </main>
  );
}
