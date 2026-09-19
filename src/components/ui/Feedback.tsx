'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * App-wide feedback: toasts for the outcome of an action, and a confirmation
 * dialog for the moment before a destructive one.
 *
 * This replaces window.alert / window.confirm everywhere. The native versions
 * block the main thread, cannot be styled or translated beyond their message,
 * render in the OS theme rather than ours, and Chrome lets a user permanently
 * suppress them for the site - after which confirm() silently returns false
 * and the guarded action can never run again.
 *
 * Mounted once in the root layout, so a toast fired just before router.push()
 * survives the navigation: the provider sits above every page and is not
 * remounted by a client-side route change.
 *
 * Messages are passed in already translated (`toast.success(t('...'))`), the
 * same contract the admin panel's toast has always had, so a caller can
 * interpolate parameters without this module knowing about them.
 */

export type ToastTone = 'success' | 'error' | 'warning' | 'info';
export type ToastOptions = {
  /** Optional bold first line; the message becomes the supporting text. */
  title?: string;
  /** Milliseconds before auto-dismiss. Defaults per tone, see DURATION. */
  duration?: number;
};

export type ToastApi = {
  /** Callable form, kept for the admin panel's `toast(message, tone)` call sites. */
  (message: string, tone?: ToastTone, options?: ToastOptions): void;
  success: (message: string, options?: ToastOptions) => void;
  error: (message: string, options?: ToastOptions) => void;
  warning: (message: string, options?: ToastOptions) => void;
  info: (message: string, options?: ToastOptions) => void;
};

export type ConfirmOptions = {
  title: string;
  body?: string;
  /** Defaults to common.confirm. Name the action ("Delete") where possible. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Default 'danger': red confirm button, and Cancel is focused first. */
  tone?: 'danger' | 'primary';
};

type ToastItem = {
  id: number;
  message: string;
  title?: string;
  tone: ToastTone;
  duration: number;
  /** Incremented when an identical toast is re-fired, restarting its timer. */
  bump: number;
};

/**
 * Errors stay up longest: a success message only confirms what the user
 * expected, while an error is new information they may need to read twice.
 */
const DURATION: Record<ToastTone, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 7000,
};

/** Older toasts are dropped past this, so a burst never covers the page. */
const MAX_VISIBLE = 4;

const TONE_STYLE: Record<ToastTone, { icon: typeof Info; iconClass: string; frame: string }> = {
  success: { icon: CheckCircle2, iconClass: 'text-verified', frame: '' },
  info: { icon: Info, iconClass: 'text-accent', frame: '' },
  warning: { icon: AlertTriangle, iconClass: 'text-warn', frame: 'border-warn/40' },
  error: { icon: XCircle, iconClass: 'text-danger', frame: 'border-danger/40' },
};

const ToastContext = createContext<ToastApi | null>(null);
const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <FeedbackProvider>');
  return api;
}

/**
 * Promise-based replacement for window.confirm:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title, body, tone: 'danger' }))) return;
 *
 * Resolves false on Cancel, Escape, a backdrop click, or when a second
 * confirmation replaces this one before it was answered.
 */
export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside <FeedbackProvider>');
  return confirm;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [announcement, setAnnouncement] = useState<{ text: string; urgent: boolean; n: number }>({
    text: '',
    urgent: false,
    n: 0,
  });
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((message: string, tone: ToastTone = 'success', options: ToastOptions = {}) => {
    const id = nextId.current++;
    setToasts((prev) => {
      // A double-click on "Save" should not stack two identical cards; it
      // restarts the timer on the one already showing.
      const duplicate = prev.find((toast) => toast.message === message && toast.tone === tone);
      if (duplicate) {
        return prev.map((toast) => (toast === duplicate ? { ...toast, bump: toast.bump + 1 } : toast));
      }
      const item: ToastItem = {
        id,
        message,
        title: options.title,
        tone,
        duration: options.duration ?? DURATION[tone],
        bump: 0,
      };
      return [...prev, item].slice(-MAX_VISIBLE);
    });
    setAnnouncement((prev) => ({
      text: options.title ? `${options.title}. ${message}` : message,
      urgent: tone === 'error' || tone === 'warning',
      n: prev.n + 1,
    }));
  }, []);

  const toastApi = useMemo<ToastApi>(
    () =>
      Object.assign((message: string, tone?: ToastTone, options?: ToastOptions) => show(message, tone, options), {
        success: (message: string, options?: ToastOptions) => show(message, 'success', options),
        error: (message: string, options?: ToastOptions) => show(message, 'error', options),
        warning: (message: string, options?: ToastOptions) => show(message, 'warning', options),
        info: (message: string, options?: ToastOptions) => show(message, 'info', options),
      }),
    [show],
  );

  // Confirmation: one dialog at a time, answered through a stored resolver.
  const [dialog, setDialog] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setDialog(options);
      }),
    [],
  );

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setDialog(null);
  }, []);

  // A pending confirmation must not leave its caller awaiting forever.
  useEffect(() => () => resolver.current?.(false), []);

  return (
    <ToastContext.Provider value={toastApi}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        <ToastViewport toasts={toasts} onDismiss={dismiss} />
        {/*
          Screen-reader announcements live in two permanently mounted regions,
          not on the cards. A live region inserted together with its text is
          announced unreliably (NVDA and VoiceOver often skip it); one that
          already exists and has its content replaced is not. Errors go to the
          assertive region because they usually mean the user's input was not
          saved; confirmations wait for a natural pause. The `key` swap makes a
          repeated identical message announce again.
        */}
        <div className="sr-only" role="status" aria-live="polite">
          {!announcement.urgent && <span key={announcement.n}>{announcement.text}</span>}
        </div>
        <div className="sr-only" role="alert" aria-live="assertive">
          {announcement.urgent && <span key={announcement.n}>{announcement.text}</span>}
        </div>
        {dialog && <ConfirmModal options={dialog} onSettle={settle} />}
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    // Bottom-centre on phones, where it sits under the thumb and clear of the
    // sticky header; bottom-right on wider screens, out of the reading column.
    // aria-hidden: the live regions above already speak the text.
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 px-4
                 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-end sm:px-6"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const t = useT();
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.duration);
  const { icon: Icon, iconClass, frame } = TONE_STYLE[toast.tone];

  // A re-fired duplicate gets its full time back.
  useEffect(() => {
    remaining.current = toast.duration;
  }, [toast.bump, toast.duration]);

  /**
   * Pauses while hovered. A toast that vanishes while the pointer is on it -
   * someone is reading it, or reaching for the close button - is an
   * accessibility failure (WCAG 2.2.1) as much as an annoyance.
   */
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [paused, toast.bump, toast.id, onDismiss]);

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={`overlay pointer-events-auto flex w-full max-w-sm animate-rise items-start gap-2.5 px-3.5 py-3 text-sm ${frame}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconClass}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {toast.title && <p className="font-semibold text-fg">{toast.title}</p>}
        <p className={`break-words ${toast.title ? 'mt-0.5 text-fg-muted' : 'text-fg'}`}>{toast.message}</p>
      </div>
      <button
        type="button"
        // Reachable by pointer only: the container is aria-hidden, so it is
        // also taken out of the tab order rather than leaving a nameless stop.
        tabIndex={-1}
        onClick={() => onDismiss(toast.id)}
        aria-label={t('common.dismiss')}
        className="-m-1 rounded p-1 text-fg-subtle transition-colors hover:text-fg"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

function ConfirmModal({ options, onSettle }: { options: ConfirmOptions; onSettle: (ok: boolean) => void }) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const danger = options.tone !== 'primary';

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // For a destructive action the safe choice holds focus, so a reflexive
    // Enter cancels instead of deleting.
    (danger ? cancelRef : confirmRef).current?.focus();

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onSettle(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [danger, onSettle]);

  return (
    <div
      className="fixed inset-0 z-[70] flex animate-fade-in items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onSettle(false);
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={options.body ? bodyId : undefined}
        className="overlay w-full max-w-md animate-scale-in p-5"
      >
        <div className="flex items-start gap-3">
          {danger && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-danger-soft">
              <AlertTriangle className="h-4 w-4 text-danger" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-fg">
              {options.title}
            </h2>
            {options.body && (
              <p id={bodyId} className="mt-1.5 text-sm leading-relaxed text-fg-muted">
                {options.body}
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button ref={cancelRef} type="button" className="btn-secondary" onClick={() => onSettle(false)}>
            {options.cancelLabel ?? t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={danger ? 'btn-danger' : 'btn-primary'}
            onClick={() => onSettle(true)}
          >
            {options.confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
