'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';
import { PASSIVE_HEADER } from '@/components/auth/SessionKeeper';
import type { SerializedNotification } from '@/lib/notifications/serialize';
import { displayParams } from '@/lib/notifications/params';

/** Fired on window with the new rows, for screens that list notifications. */
export const NOTIFICATIONS_EVENT = 'campusnotehub:notifications';
export type NotificationsEventDetail = { latest: SerializedNotification[] };

const POLL_MS = 15_000;
/** Re-asks a few seconds back each time; rows already seen are skipped by id. */
const OVERLAP_MS = 5_000;
/** Toasted as they arrive; everything else only moves the badge. */
const TOASTED = new Set([
  'POST_LIKE',
  'POST_REPLY',
  'FOLLOW_REQUEST',
  'FOLLOW_ACCEPTED',
  'NEW_FOLLOWER',
  'BOOKING_REQUESTED',
  'BOOKING_CONFIRMED',
  'BOOKING_REJECTED',
]);

export type MessageCounts = {
  /** Unread messages in open conversations. */
  unread: number;
  /** Message requests waiting for an answer. */
  requests: number;
};

type LiveState = {
  unread: number;
  followRequests: number;
  /** The direct-message badge; the messages panel also reloads when it moves. */
  messages: MessageCounts;
  /** Re-poll now, e.g. after answering a request. */
  refresh: () => void;
};

const NO_MESSAGES: MessageCounts = { unread: 0, requests: 0 };

const LiveContext = createContext<LiveState>({ unread: 0, followRequests: 0, messages: NO_MESSAGES, refresh: () => {} });

/**
 * In-app notifications, live: likes, comments and follow requests appear as a
 * toast within seconds and the bell badge follows the unread count.
 *
 * It polls GET /api/notifications/live (see that route for why this is a poll
 * and not a stream) every 15 s while the tab is VISIBLE, immediately when it
 * becomes visible again, and not at all in a background tab. The poll is
 * PASSIVE: it neither refreshes tokens nor counts as activity, so an
 * unattended tab still reaches the idle timeout. While the access token is
 * expired it quietly returns 401 until the user's next action renews it.
 *
 * Keyed by the viewer's ID, not a signed-in boolean - the same contract as
 * FollowingProvider. Mounted in the root layout, it outlives every page, so
 * the counts belong to one account and must be dropped the moment the account
 * changes; a boolean that stayed `true` from one account to the next could
 * not tell it to.
 */
export function LiveNotificationsProvider({ viewerId, children }: { viewerId: string | null; children: ReactNode }) {
  const t = useT();
  const toast = useToast();
  const [unread, setUnread] = useState(0);
  const [followRequests, setFollowRequests] = useState(0);
  const [messages, setMessages] = useState<MessageCounts>(NO_MESSAGES);
  const since = useRef<string>(new Date().toISOString());
  const seen = useRef<Set<string>>(new Set());
  const inFlight = useRef(false);
  /** The account the counts on screen belong to. */
  const owner = useRef(viewerId);
  // The latest t/toast without re-arming the timer on every render.
  const notify = useRef({ t, toast });
  useEffect(() => {
    notify.current = { t, toast };
  }, [t, toast]);

  /**
   * Signed out, or signed in as someone else: start from nothing. Declared
   * before the polling effect so, on a switch, the reset runs first and the
   * new account's first poll is not skipped as "in flight".
   */
  useEffect(() => {
    owner.current = viewerId;
    since.current = new Date().toISOString();
    seen.current = new Set();
    inFlight.current = false;
    setUnread(0);
    setFollowRequests(0);
    setMessages(NO_MESSAGES);
  }, [viewerId]);

  const poll = useCallback(async () => {
    if (!viewerId || inFlight.current || document.visibilityState !== 'visible') return;
    inFlight.current = true;
    try {
      const response = await fetch(`/api/notifications/live?since=${encodeURIComponent(since.current)}`, {
        headers: { [PASSIVE_HEADER]: '1' },
        cache: 'no-store',
      });
      if (!response.ok) return;
      const data = (await response.json()) as {
        unreadCount: number;
        followRequests: number;
        messages?: MessageCounts;
        latest: SerializedNotification[];
        serverTime: string;
      };
      // The account changed while this was in flight: these are not its rows.
      if (owner.current !== viewerId) return;
      setUnread(data.unreadCount);
      setFollowRequests(data.followRequests);
      // A new object only when a count moved, so listeners re-run only then.
      const next = data.messages ?? NO_MESSAGES;
      setMessages((prev) => (prev.unread === next.unread && prev.requests === next.requests ? prev : next));
      since.current = new Date(new Date(data.serverTime).getTime() - OVERLAP_MS).toISOString();

      const fresh = data.latest.filter((row) => !seen.current.has(row.id));
      fresh.forEach((row) => seen.current.add(row.id));
      if (fresh.length === 0) return;

      window.dispatchEvent(
        new CustomEvent<NotificationsEventDetail>(NOTIFICATIONS_EVENT, { detail: { latest: fresh } }),
      );
      // Oldest first, and at most three: a burst of likes is one glance, not a wall.
      const locale = document.documentElement.lang || 'az';
      for (const row of fresh.filter((r) => TOASTED.has(r.type)).slice(0, 3).reverse()) {
        const params = displayParams(row.params, locale);
        notify.current.toast.info(notify.current.t(row.bodyKey, params), {
          title: notify.current.t(row.titleKey, params),
        });
      }
    } catch {
      // Offline or navigating away: the next tick tries again.
    } finally {
      inFlight.current = false;
    }
  }, [viewerId]);

  useEffect(() => {
    if (!viewerId) return;
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [viewerId, poll]);

  const refresh = useCallback(() => void poll(), [poll]);
  const value = useMemo(
    () => ({ unread, followRequests, messages, refresh }),
    [unread, followRequests, messages, refresh],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLiveNotifications(): LiveState {
  return useContext(LiveContext);
}
