'use client';

import Link from 'next/link';
import {
  BadgeCheck,
  CalendarDays,
  CircleSlash,
  Clock,
  ShieldAlert,
  ShieldX,
  Timer,
  TrendingUp,
  UserRoundX,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { PageHeader } from './AdminShell';
import { ErrorState, useAdminFetch } from './primitives';

type Stats = {
  users: {
    total: number;
    verified: number;
    unverified: number;
    needsReview: number;
    processing: number;
    rejected: number;
    suspended: number;
    banned: number;
    restricted: number;
    deleted: number;
    newToday: number;
    newThisWeek: number;
  };
  verification: { queueWaiting: number; queueExpiringSoon: number };
  generatedAt: string;
};

/**
 * Stat tiles.
 *
 * Each tile links somewhere that answers the obvious follow-up question, and
 * the link carries the filter that produced the number. A dashboard whose tiles
 * are dead ends makes an operator re-derive the query by hand, and they will
 * get it subtly wrong.
 */
const TILES: {
  key: keyof Stats['users'];
  labelKey: string;
  icon: LucideIcon;
  href: string;
  tone?: 'warn' | 'danger' | 'good';
}[] = [
  { key: 'total', labelKey: 'admin.stats.total', icon: Users, href: '/admin/users' },
  { key: 'verified', labelKey: 'admin.stats.verified', icon: BadgeCheck, href: '/admin/users?verificationStatus=VERIFIED', tone: 'good' },
  { key: 'unverified', labelKey: 'admin.stats.unverified', icon: Clock, href: '/admin/users?verificationStatus=UNVERIFIED' },
  { key: 'needsReview', labelKey: 'admin.stats.needsReview', icon: ShieldAlert, href: '/admin/users?verificationStatus=NEEDS_REVIEW', tone: 'warn' },
  { key: 'processing', labelKey: 'admin.stats.processing', icon: Timer, href: '/admin/users?verificationStatus=PROCESSING' },
  { key: 'rejected', labelKey: 'admin.stats.rejected', icon: ShieldX, href: '/admin/users?verificationStatus=REJECTED', tone: 'danger' },
  { key: 'suspended', labelKey: 'admin.stats.suspended', icon: CircleSlash, href: '/admin/users?accountStatus=SUSPENDED', tone: 'warn' },
  { key: 'banned', labelKey: 'admin.stats.banned', icon: UserRoundX, href: '/admin/users?accountStatus=BANNED', tone: 'danger' },
  { key: 'newToday', labelKey: 'admin.stats.newToday', icon: TrendingUp, href: '/admin/users?sort=createdAt&order=desc' },
  { key: 'newThisWeek', labelKey: 'admin.stats.newThisWeek', icon: CalendarDays, href: '/admin/users?sort=createdAt&order=desc' },
];

const TONE_RING: Record<string, string> = {
  warn: 'text-warn-fg',
  danger: 'text-danger-fg',
  good: 'text-verified-fg',
};

function Tile({
  label,
  value,
  icon: Icon,
  href,
  tone,
  loading,
}: {
  label: string;
  value: number | null | undefined;
  icon: LucideIcon;
  href: string;
  tone?: string;
  loading: boolean;
}) {
  return (
    <Link
      href={href}
      className="card group flex flex-col gap-2 p-4 transition-colors hover:border-edge-strong"
    >
      <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-fg-subtle">
        <Icon className={`h-3.5 w-3.5 ${tone ? TONE_RING[tone] : ''}`} aria-hidden="true" />
        {label}
      </span>
      {loading ? (
        <span className="h-7 w-14 animate-pulse rounded bg-surface-muted" aria-hidden="true" />
      ) : (
        <span className="text-2xl font-bold tabular-nums tracking-tight text-fg">{value ?? '—'}</span>
      )}
    </Link>
  );
}

export function AdminDashboard() {
  const t = useT();
  const { data, error, loading, reload } = useAdminFetch<Stats>('/api/admin/stats');

  if (error) {
    return (
      <>
        <PageHeader title={t('admin.dashboard.title')} />
        <ErrorState message={t(error)} onRetry={reload} />
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('admin.dashboard.title')} description={t('admin.dashboard.subtitle')} />

      <section aria-label={t('admin.dashboard.title')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {TILES.map((tile) => (
          <Tile
            key={tile.key}
            label={t(tile.labelKey)}
            value={data?.users[tile.key]}
            icon={tile.icon}
            href={tile.href}
            tone={tile.tone}
            loading={loading}
          />
        ))}
      </section>

      <section className="card mt-4 p-4">
        <h2 className="text-sm font-semibold text-fg">{t('admin.dashboard.queueTitle')}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-6">
          <div>
            <p className="text-2xs uppercase tracking-wide text-fg-subtle">
              {t('admin.stats.queueWaiting')}
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-fg">
              {loading ? '—' : (data?.verification.queueWaiting ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wide text-fg-subtle">
              {t('admin.stats.queueExpiringSoon')}
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-warn-fg">
              {loading ? '—' : (data?.verification.queueExpiringSoon ?? 0)}
            </p>
          </div>
          <Link href="/admin/verifications" className="btn-secondary ml-auto">
            {t('admin.dashboard.openQueue')}
          </Link>
        </div>
        {/*
          The buffer TTL is a real constraint, not a nicety: documents for a
          flagged case evaporate on expiry and the case becomes unreviewable.
          Saying so next to the count is what stops a queue being left overnight.
        */}
        <p className="mt-3 text-2xs leading-relaxed text-fg-muted">
          {t('admin.dashboard.queueNote')}
        </p>
      </section>
    </>
  );
}
