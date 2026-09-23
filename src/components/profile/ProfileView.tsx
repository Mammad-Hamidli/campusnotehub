'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BadgeCheck, ExternalLink, Loader2, Pencil, ShieldAlert } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { CreatorHandle, type CreatorStats } from '@/components/notes/CreatorHandle';
import { AvatarUploader } from './AvatarUploader';

type Me = {
  id: string;
  fullName: string;
  nickname: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  headline: string | null;
  bio: string | null;
  locale: string;
  role: string;
  verificationStatus: string;
  isVerified: boolean;
  verifiedAt: string | null;
  graduationYear: number | null;
  graduationMonth: number | null;
  createdAt: string;
  initials: string;
  showRealName: string;
  showEmail: string;
  showPhone: string;
  university: { code: string; nameEn: string; city: string } | null;
  faculty: { nameEn: string } | null;
  _count: { posts: number; notes: number; followers: number; following: number };
  creatorStats: CreatorStats | null;
};

/**
 * The viewer's own profile.
 *
 * This route was a StubPage, which is the whole of the "account menu does
 * nothing" report: the menu in the sidebar is correctly wired - it has a
 * trigger, state, outside-click handling and real <Link>s - but two of its
 * three destinations went to a "not built yet" placeholder, so clicking felt
 * like nothing happened.
 *
 * Everything here comes from GET /api/me. There is no placeholder identity in
 * this file, which is the point: the previous screens hardcoded one.
 */
export function ProfileView() {
  const t = useT();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/me', { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? 'errors.generic');
        return body.user as Me;
      })
      .then(setMe)
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-sm text-fg-muted">{t(error)}</p>
        <Link href="/login" className="btn-primary mt-4">
          {t('nav.login')}
        </Link>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-fg-subtle" aria-hidden="true" />
      </div>
    );
  }

  const graduation = me.graduationYear
    ? `${me.graduationYear}-${String(me.graduationMonth ?? 1).padStart(2, '0')}`
    : '—';

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <header className="card flex flex-wrap items-start gap-4 p-5">
        <AvatarUploader
          nickname={me.nickname}
          avatarUrl={me.avatarUrl}
          verified={me.isVerified}
          onChange={(avatarUrl) => setMe((prev) => (prev ? { ...prev, avatarUrl } : prev))}
        />

        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-1.5 text-lg font-bold tracking-tight text-fg">
            <CreatorHandle nickname={me.nickname} stats={me.creatorStats} />
            {me.isVerified && (
              <BadgeCheck className="h-4 w-4 shrink-0 text-verified" aria-label={t('profile.verified')} />
            )}
          </h1>
          {me.headline && <p className="mt-0.5 text-sm text-fg-muted">{me.headline}</p>}
          <p className="mt-1 text-2xs text-fg-subtle">
            {me.university ? `${me.university.code} · ${me.university.city}` : '—'}
            {me.faculty ? ` · ${me.faculty.nameEn}` : ''}
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-2">
          <Link href="/settings" className="btn-secondary">
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            {t('profile.edit')}
          </Link>
          <Link href={`/u/${encodeURIComponent(me.nickname)}`} className="btn-ghost text-xs">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            {t('profile.viewPublic')}
          </Link>
        </div>
      </header>

      {!me.isVerified && (
        <div className="card mt-3 flex items-start gap-2 border-warn/40 bg-warn/5 p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn-fg" aria-hidden="true" />
          <p className="text-sm text-fg-muted">
            {t('profile.unverified')}{' '}
            <span className="font-mono text-2xs">{me.verificationStatus}</span>
          </p>
        </div>
      )}

      <section className="mt-3 grid gap-3 sm:grid-cols-4">
        {([
          ['profile.stats.posts', me._count.posts],
          ['profile.stats.notes', me._count.notes],
          ['profile.stats.followers', me._count.followers],
          ['profile.stats.following', me._count.following],
        ] as const).map(([labelKey, value]) => (
          <div key={labelKey} className="card p-3">
            <p className="text-2xs uppercase tracking-wide text-fg-subtle">{t(labelKey)}</p>
            {/* Real counts from the database. These used to be invented
                numbers baked into the component. */}
            <p className="mt-1 text-xl font-bold tabular-nums text-fg">{value}</p>
          </div>
        ))}
      </section>

      <section className="card mt-3 p-5">
        <h2 className="text-sm font-semibold text-fg">{t('profile.details')}</h2>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {([
            ['profile.fields.fullName', me.fullName],
            ['profile.fields.email', me.email],
            ['profile.fields.phone', me.phone ?? '—'],
            ['profile.fields.university', me.university?.nameEn ?? '—'],
            ['profile.fields.faculty', me.faculty?.nameEn ?? '—'],
            ['profile.fields.graduation', graduation],
            ['profile.fields.role', me.role],
            ['profile.fields.joined', new Date(me.createdAt).toISOString().slice(0, 10)],
          ] as const).map(([labelKey, value]) => (
            <div key={labelKey} className="min-w-0">
              <dt className="text-2xs uppercase tracking-wide text-fg-subtle">{t(labelKey)}</dt>
              <dd className="mt-0.5 break-words text-sm text-fg">{value}</dd>
            </div>
          ))}
        </dl>

        {me.bio && (
          <>
            <hr className="rule my-4" />
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">{me.bio}</p>
          </>
        )}
      </section>

      {/*
        The privacy columns already exist on `users` and are what other people
        see. Showing them here makes it obvious that "my profile" and "my
        profile as others see it" are different things.
      */}
      <section className="card mt-3 p-5">
        <h2 className="text-sm font-semibold text-fg">{t('profile.visibility')}</h2>
        <p className="mt-1 text-2xs text-fg-muted">{t('profile.visibilityHint')}</p>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
          {([
            ['profile.fields.fullName', me.showRealName],
            ['profile.fields.email', me.showEmail],
            ['profile.fields.phone', me.showPhone],
          ] as const).map(([labelKey, value]) => (
            <div key={labelKey}>
              <dt className="text-2xs uppercase tracking-wide text-fg-subtle">{t(labelKey)}</dt>
              <dd className="mt-0.5 font-mono text-2xs text-fg-muted">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
