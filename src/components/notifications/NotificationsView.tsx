'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  BadgeCheck,
  Bell,
  BookOpen,
  CalendarClock,
  Check,
  CheckCheck,
  Heart,
  Loader2,
  MessageCircle,
  ShieldAlert,
  UserCheck,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { UserAvatar } from '@/components/ui/UserAvatar';
import {
  NOTIFICATIONS_EVENT,
  useLiveNotifications,
  type NotificationsEventDetail,
} from './LiveNotifications';

/**
 * The notifications screen.
 *
 * ---------------------------------------------------------------------------
 * REAL EVENTS ONLY
 * ---------------------------------------------------------------------------
 * Every row comes from the `notifications` table, written by the code paths
 * that actually run: a comment on your post, a like, a verification decision,
 * a role change, an admin action against your account. There is deliberately
 * no seeded sample content and no fallback list when the fetch returns
 * nothing - an empty inbox is the truth about a new account, and quietly
 * substituting fiction is how a screen that was never wired up comes to look
 * finished. This replaces a StubPage that said as much honestly.
 *
 * ---------------------------------------------------------------------------
 * ROWS ARE KEYS, RENDERED HERE
 * ---------------------------------------------------------------------------
 * A row stores `titleKey`, `bodyKey` and `params` rather than a sentence -
 * the existing convention from src/lib/notifications/dispatch.ts. On a
 * trilingual product that is what lets someone switch language and have their
 * whole history switch with it, instead of ending up with a permanently
 * mixed-language list. The translation happens at THIS point, on read.
 */

type ApiNotification = {
  id: string;
  type: string;
  titleKey: string;
  bodyKey: string;
  params: Record<string, string | number>;
  linkUrl: string | null;
  read: boolean;
  createdAt: string;
};

/**
 * Icon per notification type.
 *
 * A lookup rather than a chain of conditionals so an unmapped type is a
 * missing entry with an obvious default, not a crash. NotificationType is a
 * database enum and can grow ahead of this file.
 */
const ICONS: Record<string, { icon: LucideIcon; tone: string }> = {
  VERIFICATION_APPROVED: { icon: BadgeCheck, tone: 'text-verified bg-verified-soft' },
  VERIFICATION_REJECTED: { icon: ShieldAlert, tone: 'text-danger bg-danger-soft' },
  VERIFICATION_NEEDS_REVIEW: { icon: ShieldAlert, tone: 'text-warn bg-warn-soft' },
  VERIFICATION_RESUBMIT_REQUIRED: { icon: ShieldAlert, tone: 'text-warn bg-warn-soft' },
  GRADUATION_TRANSITION_PROMPT: { icon: CalendarClock, tone: 'text-accent bg-accent-soft' },
  NOTE_REVIEWED: { icon: BookOpen, tone: 'text-accent bg-accent-soft' },
  NOTE_MODERATION: { icon: ShieldAlert, tone: 'text-warn bg-warn-soft' },
  BOOKING_REQUESTED: { icon: CalendarClock, tone: 'text-accent bg-accent-soft' },
  BOOKING_CONFIRMED: { icon: CalendarClock, tone: 'text-verified bg-verified-soft' },
  BOOKING_REMINDER_24H: { icon: CalendarClock, tone: 'text-accent bg-accent-soft' },
  BOOKING_REMINDER_1H: { icon: CalendarClock, tone: 'text-warn bg-warn-soft' },
  BOOKING_CANCELLED: { icon: CalendarClock, tone: 'text-danger bg-danger-soft' },
  POST_REPLY: { icon: MessageCircle, tone: 'text-accent bg-accent-soft' },
  POST_LIKE: { icon: Heart, tone: 'text-danger bg-danger-soft' },
  NEW_FOLLOWER: { icon: UserPlus, tone: 'text-accent bg-accent-soft' },
  FOLLOW_REQUEST: { icon: UserPlus, tone: 'text-accent bg-accent-soft' },
  FOLLOW_ACCEPTED: { icon: UserCheck, tone: 'text-verified bg-verified-soft' },
  SYSTEM: { icon: Bell, tone: 'text-fg-muted bg-surface-inset' },
};

function iconFor(type: string) {
  return ICONS[type] ?? { icon: Bell, tone: 'text-fg-muted bg-surface-inset' };
}

/** Absolute for anything older than a week; relative while it is still news. */
function when(iso: string, locale: string): string {
  const date = new Date(iso);
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

export function NotificationsView() {
  const t = useT();
  const toast = useToast();
  const [items, setItems] = useState<ApiNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/notifications?filter=${filter}&limit=50`, { signal });
        if (!response.ok) {
          setError('errors.generic');
          return;
        }
        const data = await response.json();
        setItems(data.notifications ?? []);
        setUnread(data.unreadCount ?? 0);
      } catch (cause) {
        if ((cause as Error)?.name === 'AbortError') return;
        setError('errors.generic');
      } finally {
        setLoading(false);
      }
    },
    [filter],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /**
   * Live rows from LiveNotificationsProvider: prepended as they arrive, so a
   * like or a follow request shows up here without a reload. Both filters
   * want them - a new row is by definition unread.
   */
  useEffect(() => {
    const onLive = (event: Event) => {
      const { latest } = (event as CustomEvent<NotificationsEventDetail>).detail;
      setItems((rows) => {
        const known = new Set(rows.map((row) => row.id));
        const added = latest.filter((row) => !known.has(row.id));
        return added.length ? [...added, ...rows] : rows;
      });
      setUnread((count) => count + latest.filter((row) => !row.read).length);
    };
    window.addEventListener(NOTIFICATIONS_EVENT, onLive);
    return () => window.removeEventListener(NOTIFICATIONS_EVENT, onLive);
  }, []);

  /**
   * Marks rows read.
   *
   * Optimistic, because being wrong for a moment about a read receipt costs
   * nothing, and the alternative - a row that stays bold for 300ms after you
   * click it - reads as a broken button. The server is the authority on the
   * unread COUNT, so that value is taken from the response rather than
   * decremented locally, which keeps a second tab from drifting.
   */
  const markRead = useCallback(
    async (ids: string[] | 'all') => {
      if (busy) return;
      setBusy(true);

      const previous = items;
      setItems((rows) =>
        rows.map((row) =>
          ids === 'all' || ids.includes(row.id) ? { ...row, read: true } : row,
        ),
      );

      try {
        const response = await fetch('/api/notifications', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ids === 'all' ? { op: 'readAll' } : { op: 'read', ids }),
        });
        if (!response.ok) {
          setItems(previous);
          toast.error(t('notifications.updateFailed'));
          return;
        }
        const data = await response.json();
        setUnread(data.unreadCount ?? 0);
        // Only the bulk action is announced. Opening a single notification
        // marks it read as a side effect, and a toast for that would be noise.
        if (ids === 'all') toast.success(t('notifications.allRead'));
        // The unread FILTER shows rows that just stopped matching it, so the
        // list is re-read rather than left showing stale membership.
        if (filter === 'unread') void load();
      } catch {
        setItems(previous);
        toast.error(t('notifications.updateFailed'));
      } finally {
        setBusy(false);
      }
    },
    [busy, items, filter, load, t, toast],
  );

  const locale = typeof document !== 'undefined' ? document.documentElement.lang || 'az' : 'az';

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-fg">{t('notifications.title')}</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {unread > 0 ? t('notifications.unreadCount', { count: unread }) : t('notifications.subtitle')}
          </p>
        </div>

        {unread > 0 && (
          <button
            type="button"
            onClick={() => void markRead('all')}
            disabled={busy}
            className="btn-secondary shrink-0 px-3 py-1.5 text-sm"
          >
            <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
            {t('notifications.markAllRead')}
          </button>
        )}
      </header>

      <FollowRequests />

      <div className="mb-3 flex gap-1.5" role="group" aria-label={t('notifications.title')}>
        {(['all', 'unread'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            aria-pressed={filter === option}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
              filter === option
                ? 'bg-accent text-accent-fg'
                : 'border border-edge bg-surface text-fg-muted hover:bg-surface-muted'
            }`}
          >
            {option === 'all' ? t('notifications.all') : t('notifications.unreadOnly')}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card h-[4.5rem] animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-fg-muted">{t(error)}</p>
          <button type="button" onClick={() => void load()} className="btn-secondary mt-3 px-3 py-1.5 text-sm">
            {t('common.retry')}
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft">
            <Bell className="h-6 w-6 text-accent" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-fg">{t('notifications.empty')}</h2>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-fg-muted">
            {t('notifications.emptyHint')}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const { icon: Icon, tone } = iconFor(item.type);

            const inner = (
              <>
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`}
                  aria-hidden="true"
                >
                  <Icon className="h-4 w-4" />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className={`text-sm ${item.read ? 'text-fg-muted' : 'font-semibold text-fg'}`}>
                      {t(item.titleKey, item.params)}
                    </p>
                    <time className="shrink-0 text-2xs text-fg-subtle">
                      {when(item.createdAt, locale)}
                    </time>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-fg-muted">
                    {t(item.bodyKey, item.params)}
                  </p>
                </div>

                {/* The unread dot is the only difference a colour-blind reader
                    could otherwise miss, since weight alone is subtle. */}
                {!item.read && (
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent"
                    aria-label={t('notifications.unreadOnly')}
                  />
                )}
              </>
            );

            const className = `card flex w-full items-start gap-3 p-3 text-left transition-colors hover:bg-surface-muted ${
              item.read ? '' : 'border-accent/30'
            }`;

            // A row with a destination is a link; one without is a button that
            // only marks read. Rendering the right element matters for
            // middle-click and for how a screen reader announces it.
            return (
              <li key={item.id}>
                {item.linkUrl ? (
                  <Link
                    href={item.linkUrl}
                    className={className}
                    onClick={() => {
                      if (!item.read) void markRead([item.id]);
                    }}
                  >
                    {inner}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={className}
                    onClick={() => {
                      if (!item.read) void markRead([item.id]);
                    }}
                  >
                    {inner}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type FollowRequest = {
  requesterId: string;
  createdAt: string;
  requester: { nickname: string; avatarUrl: string | null; isVerified: boolean; headline: string | null };
};

/**
 * Pending follow requests, answered in place. Re-read whenever the live
 * count moves, so a request that arrives while this page is open appears
 * here too. Rejecting leaves no trace - the requester may ask again.
 */
function FollowRequests() {
  const t = useT();
  const toast = useToast();
  const live = useLiveNotifications();
  const [requests, setRequests] = useState<FollowRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/me/follow-requests', { signal: controller.signal, cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { requests: [] }))
      .then((body: { requests?: FollowRequest[] }) => setRequests(body.requests ?? []))
      .catch((error) => {
        if ((error as Error)?.name !== 'AbortError') setRequests([]);
      });
    return () => controller.abort();
  }, [live.followRequests]);

  async function answer(request: FollowRequest, action: 'accept' | 'reject') {
    setBusy(request.requesterId);
    try {
      const res = await fetch(`/api/me/follow-requests/${encodeURIComponent(request.requesterId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = await res.json().catch(() => ({}));
      // 404: answered in another tab or withdrawn - either way it is gone.
      if (!res.ok && res.status !== 404) {
        toast.error(t(body.error ?? 'errors.generic'));
        return;
      }
      setRequests((rows) => rows?.filter((row) => row.requesterId !== request.requesterId) ?? rows);
      if (res.ok) {
        toast.success(
          t(action === 'accept' ? 'social.requests.accepted' : 'social.requests.rejected', {
            nickname: request.requester.nickname,
          }),
        );
      }
      live.refresh();
    } catch {
      toast.error(t('errors.network'));
    } finally {
      setBusy(null);
    }
  }

  if (!requests || requests.length === 0) return null;

  return (
    <section className="card mb-5 p-4" aria-labelledby="follow-requests-heading">
      <h2 id="follow-requests-heading" className="text-sm font-semibold text-fg">
        {t('social.requests.title')}{' '}
        <span className="font-normal text-fg-muted">({requests.length})</span>
      </h2>
      <ul className="mt-3 divide-y divide-edge">
        {requests.map((request) => (
          <li key={request.requesterId} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <Link href={`/u/${request.requester.nickname}`} className="flex min-w-0 flex-1 items-center gap-2.5">
              <UserAvatar
                nickname={request.requester.nickname}
                src={request.requester.avatarUrl}
                verified={request.requester.isVerified}
                size="sm"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-fg">@{request.requester.nickname}</span>
                {request.requester.headline && (
                  <span className="block truncate text-xs text-fg-muted">{request.requester.headline}</span>
                )}
              </span>
            </Link>
            <div className="flex shrink-0 gap-1.5">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void answer(request, 'accept')}
                className="btn-primary h-8 px-3 text-xs"
              >
                {busy === request.requesterId ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {t('social.requests.accept')}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void answer(request, 'reject')}
                className="btn-secondary h-8 px-3 text-xs"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                {t('social.requests.reject')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
