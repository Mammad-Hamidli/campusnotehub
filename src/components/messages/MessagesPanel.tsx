'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Ban,
  Check,
  Loader2,
  Mail,
  MoreHorizontal,
  PenSquare,
  Send,
  ShieldOff,
  X,
} from 'lucide-react';
import { useLocale } from '@/lib/i18n/LocaleProvider';
import { formatAge, formatDate } from '@/lib/i18n/dates';
import { useConfirm, useToast } from '@/components/ui/Feedback';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { PASSIVE_HEADER } from '@/components/auth/SessionKeeper';
import { useLiveNotifications } from '@/components/notifications/LiveNotifications';
import { UserSearch } from '@/components/dashboard/UserSearch';

/** The other person in a conversation, as the API returns them. */
export type ChatPeer = { id: string; nickname: string; avatarUrl: string | null; isVerified: boolean };

type InboxItem = {
  peer: ChatPeer;
  state: 'ACTIVE' | 'REQUEST_IN' | 'REQUEST_OUT';
  unread: number;
  lastMessage: { body: string; fromMe: boolean; createdAt: string };
};

type ChatMessage = { id: string; body: string; createdAt: string; fromMe: boolean; pending?: boolean };

type ThreadMeta = {
  peer: ChatPeer;
  state: 'OPEN' | 'REQUEST_OUT' | 'REQUEST_IN' | 'CLOSED';
  canSend: boolean;
  reason: string | null;
  asRequest: boolean;
  requestRoom: number;
  blockedByMe: boolean;
};
type ThreadResponse = ThreadMeta & { messages: ChatMessage[]; hasMore: boolean };

type View = 'chats' | 'requests' | 'blocked';

/** Background reads: authenticated, but not activity - see SessionKeeper and requireSession. */
const PASSIVE = { [PASSIVE_HEADER]: '1' };
/** How often an OPEN thread asks for new messages while the tab is visible. */
const THREAD_POLL_MS = 4_000;
const MAX_LENGTH = 2000;

/**
 * Direct messages, in the dashboard's right column (and as the Messages tab
 * on screens too narrow for that column).
 *
 * The inbox has two lists - Chats (open conversations, and requests this
 * viewer sent, marked pending) and Requests (people asking to message the
 * viewer, who may accept, reject or block) - plus the viewer's blocks. The
 * rules themselves are the server's (src/lib/messages/service.ts); this
 * renders what GET /api/messages/:peerId says the viewer may do.
 *
 * Freshness without a socket: the inbox reloads whenever the live
 * notification heartbeat's message counts move (no poll of its own), and an
 * open thread polls for new messages every few seconds while the tab is
 * visible. Both reads are passive, so an unattended tab still times out.
 *
 * `openPeer` is lifted to the dashboard so the user search's "Message" button
 * can open a conversation here.
 */
export function MessagesPanel({
  openPeer,
  onOpenPeer,
  tall = false,
  className = '',
}: {
  openPeer: ChatPeer | null;
  onOpenPeer: (peer: ChatPeer | null) => void;
  /** The full-width tab: a taller thread. */
  tall?: boolean;
  className?: string;
}) {
  const { locale, t } = useLocale();
  const live = useLiveNotifications();
  const [view, setView] = useState<View>('chats');
  const [inbox, setInbox] = useState<InboxItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [composing, setComposing] = useState(false);
  const loadedOnce = useRef(false);

  // On mount, whenever the heartbeat's counts move, and on coming back from a thread.
  useEffect(() => {
    if (openPeer) return;
    const controller = new AbortController();
    fetch('/api/messages', {
      headers: loadedOnce.current ? PASSIVE : undefined,
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((body: { conversations: InboxItem[] }) => {
        loadedOnce.current = true;
        setInbox(body.conversations);
        setFailed(false);
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setFailed(true);
      });
    return () => controller.abort();
  }, [openPeer, live.messages]);

  const chats = inbox?.filter((item) => item.state !== 'REQUEST_IN') ?? [];
  const requests = inbox?.filter((item) => item.state === 'REQUEST_IN') ?? [];
  const unread = chats.reduce((sum, item) => sum + (item.state === 'ACTIVE' ? item.unread : 0), 0);

  if (openPeer) {
    return (
      <section className={`card flex flex-col overflow-hidden ${className}`} aria-label={t('messages.title')}>
        <Conversation
          key={openPeer.id}
          peer={openPeer}
          tall={tall}
          onBack={() => {
            onOpenPeer(null);
            live.refresh();
          }}
        />
      </section>
    );
  }

  const tabs: { id: View; label: string; count: number }[] = [
    { id: 'chats', label: t('messages.tabs.chats'), count: unread },
    { id: 'requests', label: t('messages.tabs.requests'), count: requests.length },
    { id: 'blocked', label: t('messages.tabs.blocked'), count: 0 },
  ];
  const rows = view === 'chats' ? chats : requests;

  return (
    <section className={`card overflow-hidden ${className}`} aria-labelledby="messages-title">
      <header className="flex items-center justify-between gap-2 border-b border-edge px-4 py-3">
        <h2 id="messages-title" className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Mail className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
          {t('messages.title')}
        </h2>
        <button
          type="button"
          onClick={() => setComposing((open) => !open)}
          aria-expanded={composing}
          title={t(composing ? 'common.close' : 'messages.newMessage.title')}
          aria-label={t(composing ? 'common.close' : 'messages.newMessage.title')}
          className="rounded-lg p-1.5 text-fg-muted transition hover:bg-surface-inset hover:text-fg"
        >
          {composing ? <X className="h-4 w-4" aria-hidden="true" /> : <PenSquare className="h-4 w-4" aria-hidden="true" />}
        </button>
      </header>

      {composing ? (
        <UserSearch
          autoFocus
          className="rounded-none border-0 shadow-none"
          onPick={(user) => {
            setComposing(false);
            onOpenPeer({ id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl, isVerified: user.isVerified });
          }}
        />
      ) : (
        <>
          <div className="flex gap-1 border-b border-edge px-2 py-1.5" role="tablist" aria-label={t('messages.title')}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={view === tab.id}
                onClick={() => setView(tab.id)}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                  view === tab.id ? 'bg-surface-inset text-fg' : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
                }`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className="min-w-4 rounded-full bg-accent px-1 text-center text-2xs font-semibold leading-4 text-accent-fg">
                    {tab.count > 99 ? '99+' : tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {view === 'blocked' ? (
            <BlockedList />
          ) : failed && !inbox ? (
            <p className="p-4 text-xs text-danger">{t('messages.loadFailed')}</p>
          ) : !inbox ? (
            <div className="space-y-2 p-4" aria-busy="true">
              <div className="h-10 animate-pulse rounded-lg bg-surface-inset" />
              <div className="h-10 animate-pulse rounded-lg bg-surface-inset" />
            </div>
          ) : rows.length === 0 ? (
            <p className="p-4 text-xs leading-relaxed text-fg-muted">
              {t(view === 'chats' ? 'messages.empty.chats' : 'messages.empty.requests')}
            </p>
          ) : (
            <ul className={`divide-y divide-edge overflow-y-auto ${tall ? 'max-h-[60vh]' : 'max-h-96'}`}>
              {rows.map((item) => (
                <li key={item.peer.id}>
                  <button
                    type="button"
                    onClick={() => onOpenPeer(item.peer)}
                    className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition hover:bg-surface-muted"
                  >
                    <UserAvatar
                      nickname={item.peer.nickname}
                      src={item.peer.avatarUrl}
                      verified={item.peer.isVerified}
                      verifiedLabel={t('profile.verified')}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className={`truncate text-sm ${item.unread > 0 ? 'font-semibold text-fg' : 'font-medium text-fg'}`}>
                          @{item.peer.nickname}
                        </span>
                        {item.state === 'REQUEST_OUT' && (
                          <span className="shrink-0 rounded border border-edge px-1 text-2xs text-fg-subtle">
                            {t('messages.pending')}
                          </span>
                        )}
                        <time
                          dateTime={item.lastMessage.createdAt}
                          title={formatDate(item.lastMessage.createdAt, locale, 'dateTime')}
                          className="ml-auto shrink-0 text-2xs text-fg-subtle"
                        >
                          {formatAge(item.lastMessage.createdAt, locale, t, { absoluteAfterDays: 7 })}
                        </time>
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        <span className={`min-w-0 flex-1 truncate text-xs ${item.unread > 0 ? 'text-fg' : 'text-fg-muted'}`}>
                          {item.lastMessage.fromMe ? t('messages.you', { body: item.lastMessage.body }) : item.lastMessage.body}
                        </span>
                        {item.unread > 0 && (
                          <span
                            className="min-w-4 shrink-0 rounded-full bg-accent px-1 text-center text-2xs font-semibold leading-4 text-accent-fg"
                            aria-label={t('messages.unreadCount', { count: item.unread })}
                          >
                            {item.unread > 99 ? '99+' : item.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** The people this viewer blocked, each with a way back. */
function BlockedList() {
  const { t } = useLocale();
  const toast = useToast();
  const [people, setPeople] = useState<ChatPeer[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/me/blocks', { signal: controller.signal, cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { blocked: [] }))
      .then((body: { blocked: ChatPeer[] }) => setPeople(body.blocked))
      .catch(() => setPeople((current) => current ?? []));
    return () => controller.abort();
  }, []);

  async function unblock(person: ChatPeer) {
    setBusy(person.id);
    try {
      const response = await fetch(`/api/me/blocks/${encodeURIComponent(person.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(String(response.status));
      setPeople((current) => current?.filter((p) => p.id !== person.id) ?? null);
      toast.success(t('messages.unblocked', { nickname: person.nickname }));
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(null);
    }
  }

  if (!people) return <div className="m-4 h-10 animate-pulse rounded-lg bg-surface-inset" aria-busy="true" />;
  if (people.length === 0) return <p className="p-4 text-xs text-fg-muted">{t('messages.empty.blocked')}</p>;
  return (
    <ul className="max-h-96 divide-y divide-edge overflow-y-auto">
      {people.map((person) => (
        <li key={person.id} className="flex items-center gap-2.5 px-4 py-2">
          <UserAvatar nickname={person.nickname} src={person.avatarUrl} verified={person.isVerified} size="sm" />
          <span className="min-w-0 flex-1 truncate text-sm text-fg">@{person.nickname}</span>
          <button
            type="button"
            onClick={() => void unblock(person)}
            disabled={busy !== null}
            className="btn-secondary shrink-0 px-2.5 py-1 text-xs"
          >
            {busy === person.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />}
            {t('messages.unblock')}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Adds what is not there yet (by id), replacing an optimistic copy, oldest first. */
function merge(current: ChatMessage[], incoming: ChatMessage[], replacing?: string): ChatMessage[] {
  const kept = replacing ? current.filter((m) => m.id !== replacing) : current;
  const ids = new Set(kept.map((m) => m.id));
  const fresh = incoming.filter((m) => !ids.has(m.id));
  if (fresh.length === 0 && kept === current) return current;
  return [...kept, ...fresh].sort((a, b) => Number(a.pending ?? false) - Number(b.pending ?? false) || a.createdAt.localeCompare(b.createdAt));
}

function Conversation({ peer, tall, onBack }: { peer: ChatPeer; tall: boolean; onBack: () => void }) {
  const { locale, t } = useLocale();
  const toast = useToast();
  const confirm = useConfirm();
  const [meta, setMeta] = useState<ThreadMeta | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** Set before prepending an earlier page, to keep the reader's place. */
  const anchor = useRef<number | null>(null);
  const latest = useRef<string | null>(null);
  const url = `/api/messages/${encodeURIComponent(peer.id)}`;

  useEffect(() => {
    latest.current = messages.reduce<string | null>(
      (max, m) => (!m.pending && (!max || m.createdAt > max) ? m.createdAt : max),
      null,
    );
  }, [messages]);

  /** Re-reads what the viewer may do, plus anything new. */
  const refresh = useCallback(
    async (passive: boolean) => {
      const after = latest.current;
      const response = await fetch(after ? `${url}?after=${encodeURIComponent(after)}` : url, {
        headers: passive ? PASSIVE : undefined,
        cache: 'no-store',
      });
      if (!response.ok) {
        if (response.status === 404) setLoadError('messages.errors.unavailable');
        return;
      }
      const { messages: incoming, hasMore: more, ...rest } = (await response.json()) as ThreadResponse;
      setMeta(rest);
      setMessages((current) => merge(current, incoming));
      if (!after) setHasMore(more);
    },
    [url],
  );

  useEffect(() => {
    let alive = true;
    refresh(false).catch(() => alive && setLoadError('messages.loadFailed'));
    return () => {
      alive = false;
    };
  }, [refresh]);

  // Polls only once the thread has loaded, and only while the tab is visible.
  const loaded = meta !== null;
  useEffect(() => {
    if (!loaded) return;
    let inFlight = false;
    const tick = () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      refresh(true)
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = window.setInterval(tick, THREAD_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [loaded, refresh]);

  // Keeps the newest message in view - unless the reader scrolled up to read.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    if (anchor.current !== null) {
      box.scrollTop = box.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (atBottom.current) {
      box.scrollTop = box.scrollHeight;
    }
  }, [messages]);

  async function loadEarlier() {
    const oldest = messages.find((m) => !m.pending);
    if (!oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const response = await fetch(`${url}?before=${encodeURIComponent(oldest.createdAt)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as ThreadResponse;
      anchor.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
      setMessages((current) => merge(body.messages, current));
      setHasMore(body.hasMore);
    } catch {
      toast.error(t('messages.loadFailed'));
    } finally {
      setLoadingEarlier(false);
    }
  }

  async function send() {
    const body = draft.trim();
    if (!body || sending || !meta?.canSend) return;
    const tempId = `pending-${Date.now()}`;
    atBottom.current = true;
    setMessages((current) => [...current, { id: tempId, body, createdAt: new Date().toISOString(), fromMe: true, pending: true }]);
    setDraft('');
    setSending(true);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessages((current) => current.filter((m) => m.id !== tempId));
        setDraft(body);
        toast.error(t(payload?.error ?? 'messages.failed'));
        void refresh(false).catch(() => {});
        return;
      }
      setMessages((current) => merge(current, [payload.message as ChatMessage], tempId));
      // State and the request allowance changed with this message.
      void refresh(false).catch(() => {});
    } catch {
      setMessages((current) => current.filter((m) => m.id !== tempId));
      setDraft(body);
      toast.error(t('errors.network'));
    } finally {
      setSending(false);
    }
  }

  async function respond(action: 'accept' | 'reject' | 'block') {
    if (action === 'block') {
      const ok = await confirm({
        title: t('messages.blockConfirm.title', { nickname: peer.nickname }),
        body: t('messages.blockConfirm.body'),
        confirmLabel: t('messages.block'),
      });
      if (!ok) return;
    }
    setBusy(action);
    try {
      const response =
        action === 'block' && meta?.state !== 'REQUEST_IN'
          ? await fetch(`/api/me/blocks/${encodeURIComponent(peer.id)}`, { method: 'PUT' })
          : await fetch(`${url}/respond`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action }),
            });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(t(payload?.error ?? 'errors.generic'));
        void refresh(false).catch(() => {});
        return;
      }
      if (action === 'accept') {
        toast.success(t('messages.accepted', { nickname: peer.nickname }));
        await refresh(false);
      } else {
        toast.success(t(action === 'block' ? 'messages.blockedToast' : 'messages.rejected', { nickname: peer.nickname }));
        onBack();
      }
    } catch {
      toast.error(t('errors.network'));
    } finally {
      setBusy(null);
    }
  }

  async function unblock() {
    setBusy('unblock');
    try {
      const response = await fetch(`/api/me/blocks/${encodeURIComponent(peer.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(String(response.status));
      toast.success(t('messages.unblocked', { nickname: peer.nickname }));
      await refresh(false);
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(null);
    }
  }

  const today = formatDate(new Date(), locale, 'date');
  const timeOf = (iso: string) =>
    formatDate(iso, locale, formatDate(iso, locale, 'date') === today ? 'time' : 'dayMonthTime');
  const shown = meta?.peer ?? peer;

  return (
    <>
      <header className="flex items-center gap-2 border-b border-edge px-2 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('messages.back')}
          title={t('messages.back')}
          className="rounded-lg p-1.5 text-fg-muted transition hover:bg-surface-inset hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <Link href={`/u/${encodeURIComponent(shown.nickname)}`} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-0.5">
          <UserAvatar nickname={shown.nickname} src={shown.avatarUrl} verified={shown.isVerified} verifiedLabel={t('profile.verified')} size="sm" />
          <span className="truncate text-sm font-semibold text-fg">@{shown.nickname}</span>
        </Link>
        {meta && meta.state !== 'REQUEST_IN' && !meta.blockedByMe && (
          <Menu
            label={t('messages.menu')}
            width="w-44"
            trigger={({ open, toggle, id }) => (
              <button
                type="button"
                data-menu-trigger
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={id}
                aria-label={t('messages.menu')}
                onClick={toggle}
                className="rounded-lg p-1.5 text-fg-subtle transition hover:bg-surface-inset hover:text-fg"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          >
            {({ close }) => (
              <MenuItem
                tone="danger"
                icon={<Ban className="h-4 w-4" />}
                onSelect={() => {
                  close();
                  void respond('block');
                }}
              >
                {t('messages.block')}
              </MenuItem>
            )}
          </Menu>
        )}
      </header>

      <div
        ref={scroller}
        onScroll={(event) => {
          const box = event.currentTarget;
          atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
        }}
        // A fixed height, not flex-1: in an auto-height column a zero flex
        // basis collapses the thread to its content.
        className={`space-y-1.5 overflow-y-auto px-3 py-3 ${tall ? 'h-[55vh]' : 'h-80'}`}
        aria-live="polite"
        aria-relevant="additions"
      >
        {loadError ? (
          <p className="text-xs text-danger">{t(loadError)}</p>
        ) : !meta ? (
          <div className="flex h-full items-center justify-center" aria-busy="true">
            <Loader2 className="h-5 w-5 animate-spin text-fg-subtle" aria-hidden="true" />
          </div>
        ) : (
          <>
            {hasMore && (
              <button
                type="button"
                onClick={() => void loadEarlier()}
                disabled={loadingEarlier}
                className="mx-auto mb-2 flex items-center gap-1 rounded-full border border-edge px-3 py-1 text-2xs font-medium text-fg-muted hover:bg-surface-muted"
              >
                {loadingEarlier && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                {t('messages.loadEarlier')}
              </button>
            )}
            {messages.length === 0 && (
              <p className="pt-6 text-center text-xs text-fg-muted">{t('messages.startHint', { nickname: shown.nickname })}</p>
            )}
            {messages.map((message) => (
              <div key={message.id} className={`flex ${message.fromMe ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-sm ${
                    message.fromMe ? 'rounded-br-md bg-accent text-accent-fg' : 'rounded-bl-md bg-surface-inset text-fg'
                  } ${message.pending ? 'opacity-60' : ''}`}
                >
                  <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  <time
                    dateTime={message.createdAt}
                    title={formatDate(message.createdAt, locale, 'dateTime')}
                    className={`mt-0.5 block text-right text-[0.625rem] ${message.fromMe ? 'opacity-75' : 'text-fg-subtle'}`}
                  >
                    {message.pending ? t('messages.sending') : timeOf(message.createdAt)}
                  </time>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {meta && (
        <footer className="border-t border-edge p-2.5">
          {meta.state === 'REQUEST_IN' ? (
            <div className="space-y-2">
              <p className="text-xs leading-relaxed text-fg">
                <span className="font-semibold">{t('messages.incoming.title', { nickname: shown.nickname })}</span>{' '}
                <span className="text-fg-muted">{t('messages.incoming.body')}</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => void respond('accept')} disabled={busy !== null} className="btn-primary px-3 py-1.5 text-xs">
                  {busy === 'accept' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                  {t('messages.accept')}
                </button>
                <button type="button" onClick={() => void respond('reject')} disabled={busy !== null} className="btn-secondary px-3 py-1.5 text-xs">
                  {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <X className="h-3.5 w-3.5" aria-hidden="true" />}
                  {t('messages.reject')}
                </button>
                <button
                  type="button"
                  onClick={() => void respond('block')}
                  disabled={busy !== null}
                  className="btn-secondary px-3 py-1.5 text-xs text-danger"
                >
                  {busy === 'block' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Ban className="h-3.5 w-3.5" aria-hidden="true" />}
                  {t('messages.block')}
                </button>
              </div>
            </div>
          ) : !meta.canSend ? (
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-fg-muted">
                {meta.blockedByMe ? t('messages.blockedNotice', { nickname: shown.nickname }) : t(meta.reason ?? 'errors.forbidden')}
              </p>
              {meta.blockedByMe && (
                <button type="button" onClick={() => void unblock()} disabled={busy !== null} className="btn-secondary shrink-0 px-2.5 py-1 text-xs">
                  {busy === 'unblock' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />}
                  {t('messages.unblock')}
                </button>
              )}
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              {meta.asRequest && (
                <p className="mb-1.5 text-2xs leading-relaxed text-fg-muted">
                  {meta.state === 'REQUEST_OUT'
                    ? t('messages.pendingHint', { nickname: shown.nickname, count: meta.requestRoom })
                    : t('messages.requestHint', { nickname: shown.nickname })}
                </p>
              )}
              <div className="flex items-end gap-1.5">
                <label htmlFor={`dm-${peer.id}`} className="sr-only">
                  {t('messages.placeholder')}
                </label>
                <textarea
                  id={`dm-${peer.id}`}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value.slice(0, MAX_LENGTH))}
                  onKeyDown={(event) => {
                    // Enter sends; Shift+Enter is a new line; an IME composing a word keeps Enter.
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  rows={1}
                  placeholder={t('messages.placeholder')}
                  className="input max-h-28 min-h-9 flex-1 resize-none py-1.5 text-sm"
                />
                <button
                  type="submit"
                  disabled={sending || draft.trim().length === 0}
                  aria-label={t('messages.send')}
                  title={t('messages.send')}
                  className="btn-primary h-9 w-9 shrink-0 p-0"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
              {draft.length > MAX_LENGTH - 200 && (
                <p className="mt-1 text-right text-2xs text-fg-subtle">
                  {t('messages.counter', { count: draft.length, max: MAX_LENGTH })}
                </p>
              )}
            </form>
          )}
        </footer>
      )}
    </>
  );
}
