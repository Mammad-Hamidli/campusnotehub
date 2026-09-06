'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, MessageSquare, Send } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { VerifiedBadge } from '@/components/dashboard/VerificationBanner';

/**
 * Messages: an inbox beside one open conversation.
 *
 * ---------------------------------------------------------------------------
 * BACKED BY THE DATABASE, NOT BY LOCAL STATE
 * ---------------------------------------------------------------------------
 * Everything here reads and writes through /api/messages, against the
 * `conversations` / `messages` tables added for this feature. Nothing is kept
 * only in the browser: a message this component shows has been committed, and
 * a message it fails to send is reported as failed rather than painted into
 * the thread. That is the difference between a messaging feature and a
 * convincing mock, and it is why the send path awaits the response before
 * appending.
 *
 * ---------------------------------------------------------------------------
 * ONE COMPONENT, TWO LAYOUTS
 * ---------------------------------------------------------------------------
 * On a wide screen the list and the thread sit side by side. On a phone there
 * is no room for both, so the list becomes a full screen that the thread
 * replaces, with a back control - the standard mail-app pattern. This is done
 * with responsive classes over one piece of state rather than two components,
 * so the open conversation survives a resize.
 */

type Participant = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  isVerified: boolean;
  headline: string | null;
  university: { code: string } | null;
} | null;

type Conversation = {
  id: string;
  participant: Participant;
  lastMessage: { id: string; body: string; isDeleted: boolean; fromMe: boolean; createdAt: string } | null;
  lastMessageAt: string;
  unreadCount: number;
};

type Message = {
  id: string;
  body: string;
  isDeleted: boolean;
  fromMe: boolean;
  senderId: string;
  createdAt: string;
};

function initialsOf(nickname: string): string {
  return nickname.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
}

function when(iso: string, locale: string): string {
  const date = new Date(iso);
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

function clockTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

export function MessagesView() {
  const t = useT();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [participant, setParticipant] = useState<Participant>(null);

  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const locale = typeof document !== 'undefined' ? document.documentElement.lang || 'az' : 'az';

  const loadList = useCallback(async (signal?: AbortSignal) => {
    setLoadingList(true);
    setListError(null);
    try {
      const response = await fetch('/api/messages', { signal });
      if (!response.ok) {
        setListError('messages.errors.loadFailed');
        return;
      }
      const data = await response.json();
      setConversations(data.conversations ?? []);
    } catch (cause) {
      if ((cause as Error)?.name === 'AbortError') return;
      setListError('messages.errors.loadFailed');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadList(controller.signal);
    return () => controller.abort();
  }, [loadList]);

  /** Opens a thread and marks it read in the same step. */
  const openConversation = useCallback(async (conversationId: string) => {
    setActiveId(conversationId);
    setLoadingThread(true);
    setSendError(null);
    setMessages([]);

    try {
      const response = await fetch(`/api/messages/${conversationId}`);
      if (!response.ok) {
        setSendError('messages.errors.loadFailed');
        return;
      }
      const data = await response.json();
      setMessages(data.messages ?? []);
      setParticipant(data.participant ?? null);

      // Reading a thread IS marking it read. Fire-and-forget: a failed read
      // receipt must not stop the messages from being displayed.
      void fetch(`/api/messages/${conversationId}`, { method: 'PATCH' }).then(() => {
        setConversations((rows) =>
          rows.map((row) => (row.id === conversationId ? { ...row, unreadCount: 0 } : row)),
        );
      });
    } catch {
      setSendError('messages.errors.loadFailed');
    } finally {
      setLoadingThread(false);
    }
  }, []);

  // Keeps the newest message in view when a thread opens or grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !activeId || sending) return;

    setSending(true);
    setSendError(null);

    try {
      const response = await fetch(`/api/messages/${activeId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        // The draft is deliberately NOT cleared. Losing what someone typed
        // because the network blipped is the worst outcome in a chat UI.
        setSendError(payload?.error ?? 'messages.errors.sendFailed');
        return;
      }

      if (payload?.message) {
        setMessages((prev) => [...prev, payload.message as Message]);
        // Move the thread to the top of the inbox, matching the server's
        // lastMessageAt ordering, so the list does not need a refetch.
        setConversations((rows) => {
          const next = rows.map((row) =>
            row.id === activeId
              ? {
                  ...row,
                  lastMessage: {
                    id: payload.message.id,
                    body: payload.message.body,
                    isDeleted: false,
                    fromMe: true,
                    createdAt: payload.message.createdAt,
                  },
                  lastMessageAt: payload.message.createdAt,
                }
              : row,
          );
          return next.sort(
            (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
          );
        });
      }

      setDraft('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
    } catch {
      setSendError('messages.errors.sendFailed');
    } finally {
      setSending(false);
    }
  }

  const list = (
    <div className="flex h-full flex-col">
      <header className="border-b border-edge px-4 py-3">
        <h1 className="text-lg font-bold tracking-tight text-fg">{t('messages.title')}</h1>
        <p className="mt-0.5 text-xs text-fg-muted">{t('messages.subtitle')}</p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loadingList ? (
          <div className="space-y-2 p-3" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-muted" />
            ))}
          </div>
        ) : listError ? (
          <div className="p-6 text-center">
            <p className="text-sm text-fg-muted">{t(listError)}</p>
            <button
              type="button"
              onClick={() => void loadList()}
              className="btn-secondary mt-3 px-3 py-1.5 text-sm"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft">
              <MessageSquare className="h-5 w-5 text-accent" aria-hidden="true" />
            </span>
            <p className="mt-3 text-sm font-semibold text-fg">{t('messages.empty')}</p>
            <p className="mt-1 max-w-xs text-xs leading-relaxed text-fg-muted">
              {t('messages.emptyHint')}
            </p>
          </div>
        ) : (
          <ul>
            {conversations.map((conversation) => {
              const active = conversation.id === activeId;
              // Null when the other account was deleted. A tombstone keeps the
              // history readable instead of crashing on a missing name.
              const name = conversation.participant?.nickname ?? '—';
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => void openConversation(conversation.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`flex w-full items-start gap-3 border-b border-edge px-4 py-3 text-left transition-colors hover:bg-surface-muted ${
                      active ? 'bg-surface-muted' : ''
                    }`}
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-inset text-2xs font-bold text-accent"
                      aria-hidden="true"
                    >
                      {initialsOf(name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-fg">@{name}</span>
                        {conversation.participant?.isVerified && (
                          <VerifiedBadge verified />
                        )}
                        <span className="ml-auto shrink-0 text-2xs text-fg-subtle">
                          {when(conversation.lastMessageAt, locale)}
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        <span
                          className={`min-w-0 flex-1 truncate text-xs ${
                            conversation.unreadCount > 0 ? 'font-medium text-fg' : 'text-fg-muted'
                          }`}
                        >
                          {conversation.lastMessage
                            ? `${conversation.lastMessage.fromMe ? `${t('messages.you')}: ` : ''}${
                                conversation.lastMessage.isDeleted
                                  ? t('messages.deleted')
                                  : conversation.lastMessage.body
                              }`
                            : '—'}
                        </span>
                        {conversation.unreadCount > 0 && (
                          <span className="tabular shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-2xs font-semibold text-accent-fg">
                            {conversation.unreadCount}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );

  const thread = (
    <div className="flex h-full flex-col">
      {!activeId ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-inset">
            <MessageSquare className="h-6 w-6 text-fg-subtle" aria-hidden="true" />
          </span>
          <p className="mt-3 text-sm text-fg-muted">{t('messages.selectPrompt')}</p>
        </div>
      ) : (
        <>
          <header className="flex items-center gap-3 border-b border-edge px-4 py-3">
            {/* Only reachable on mobile, where the thread covers the list. */}
            <button
              type="button"
              onClick={() => setActiveId(null)}
              aria-label={t('messages.backToList')}
              className="btn-ghost -ml-2 h-8 w-8 p-0 lg:hidden"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-inset text-2xs font-bold text-accent"
              aria-hidden="true"
            >
              {initialsOf(participant?.nickname ?? '—')}
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
                @{participant?.nickname ?? '—'}
                {participant?.isVerified && <VerifiedBadge verified />}
              </p>
              {participant?.headline && (
                <p className="truncate text-2xs text-fg-muted">{participant.headline}</p>
              )}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {loadingThread ? (
              <p className="py-6 text-center text-xs text-fg-muted" aria-busy="true">
                {t('messages.loading')}
              </p>
            ) : (
              <ul className="space-y-2">
                {messages.map((message) => (
                  <li
                    key={message.id}
                    className={`flex ${message.fromMe ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
                        message.fromMe
                          ? 'bg-accent text-accent-fg'
                          : 'border border-edge bg-surface text-fg'
                      }`}
                    >
                      <p
                        className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${
                          message.isDeleted ? 'italic opacity-70' : ''
                        }`}
                      >
                        {message.isDeleted ? t('messages.deleted') : message.body}
                      </p>
                      <time
                        className={`mt-0.5 block text-right text-2xs ${
                          message.fromMe ? 'text-accent-fg/70' : 'text-fg-subtle'
                        }`}
                      >
                        {clockTime(message.createdAt, locale)}
                      </time>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div ref={bottomRef} />
          </div>

          <form onSubmit={send} className="border-t border-edge p-3">
            <div className="flex items-end gap-2">
              <label htmlFor="message-input" className="sr-only">
                {t('messages.placeholder')}
              </label>
              <textarea
                id="message-input"
                ref={inputRef}
                value={draft}
                rows={1}
                maxLength={4000}
                onChange={(e) => {
                  setDraft(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
                }}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter breaks the line - chat convention.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(e as unknown as React.FormEvent);
                  }
                }}
                placeholder={t('messages.placeholder')}
                className="input max-h-36 min-h-[2.25rem] resize-none py-1.5 text-sm"
              />
              <button
                type="submit"
                disabled={!draft.trim() || sending}
                aria-label={t('messages.send')}
                className="btn-primary h-9 shrink-0 px-3"
              >
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            </div>
            {sendError && (
              <p className="mt-1.5 text-xs text-danger" role="alert">
                {t(sendError)}
              </p>
            )}
          </form>
        </>
      )}
    </div>
  );

  return (
    <div className="mx-auto h-dvh w-full max-w-6xl px-0 sm:px-4 sm:py-4">
      <div className="card flex h-full overflow-hidden">
        {/* Mobile shows exactly one pane; lg and up shows both. */}
        <div
          className={`w-full shrink-0 border-edge lg:flex lg:w-80 lg:border-r ${
            activeId ? 'hidden lg:block' : 'block'
          }`}
        >
          {list}
        </div>
        <div className={`min-w-0 flex-1 ${activeId ? 'block' : 'hidden lg:block'}`}>{thread}</div>
      </div>
    </div>
  );
}
