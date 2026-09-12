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
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Inbox, Loader2, X } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * Shared building blocks for the admin panel.
 *
 * These are deliberately local to /components/admin rather than promoted into
 * components/ui. The public product has its own visual language and its own
 * accessibility budget; a data table with sortable headers and a destructive
 * confirmation dialog belongs to the back office and would be dead weight in
 * the student-facing bundle. Everything here still uses the same design tokens
 * and .btn/.card classes, so the panel does not look like a different product.
 */

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

type Tone = 'neutral' | 'positive' | 'warning' | 'danger' | 'accent';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-edge bg-surface-muted text-fg-muted',
  positive: 'border-verified/30 bg-verified/10 text-verified-fg',
  warning: 'border-warn/30 bg-warn/10 text-warn-fg',
  danger: 'border-danger/30 bg-danger/10 text-danger-fg',
  // `text-accent`, NOT `text-accent-fg`: the -fg token is the colour that sits
  // ON a solid accent fill (white in light, near-black in dark), and this tone
  // is a 10% tint. Pairing them rendered the ADMIN and MODERATOR role pills at
  // 1.16:1 - white on pale blue - in both themes.
  accent: 'border-accent/30 bg-accent/10 text-accent',
};

/**
 * Status colours are assigned centrally so the same state never renders green
 * on one screen and grey on another - which is how an operator learns to
 * distrust the colour and read every label instead.
 */
const VERIFICATION_TONE: Record<string, Tone> = {
  VERIFIED: 'positive',
  UNVERIFIED: 'neutral',
  PROCESSING: 'accent',
  NEEDS_REVIEW: 'warning',
  REJECTED: 'danger',
  BANNED: 'danger',
};

const ACCOUNT_TONE: Record<string, Tone> = {
  ACTIVE: 'positive',
  RESTRICTED: 'warning',
  SUSPENDED: 'warning',
  BANNED: 'danger',
  DELETED: 'danger',
};

const ROLE_TONE: Record<string, Tone> = {
  ADMIN: 'accent',
  MODERATOR: 'accent',
};

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-2xs font-medium ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Enum values render as the raw token (VERIFIED, NEEDS_REVIEW) rather than a
 * translated word. In a back office that is the correct choice: the value an
 * operator sees is the value in the database, in the API response and in the
 * audit log, so a support conversation and a bug report describe the same
 * thing. Translating them would put a layer of ambiguity between the screen
 * and the data.
 */
export function StatusBadge({ kind, value }: { kind: 'verification' | 'account' | 'role'; value: string }) {
  const table = kind === 'verification' ? VERIFICATION_TONE : kind === 'account' ? ACCOUNT_TONE : ROLE_TONE;
  return <Badge tone={table[value] ?? 'neutral'}>{value}</Badge>;
}

// ---------------------------------------------------------------------------
// Loading / empty / error states
// ---------------------------------------------------------------------------

/**
 * Skeleton rows sized to the table that will replace them.
 *
 * The row count is passed in rather than fixed so the placeholder occupies
 * roughly the height of the real content. A skeleton that is much shorter than
 * the data causes a layout jump on arrival, which is worse than a spinner.
 */
export function TableSkeleton({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="animate-pulse" aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3 border-b border-edge px-4 py-3">
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={c}
              className="h-4 rounded bg-surface-muted"
              style={{ width: c === 0 ? '22%' : `${Math.max(8, 60 / cols)}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-edge bg-surface-muted">
        <Inbox className="h-5 w-5 text-fg-subtle" aria-hidden="true" />
      </div>
      <p className="mt-4 text-sm font-medium text-fg">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-fg-muted">{hint}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center px-4 py-16 text-center"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-danger/30 bg-danger/10">
        <AlertTriangle className="h-5 w-5 text-danger-fg" aria-hidden="true" />
      </div>
      <p className="mt-4 text-sm font-medium text-fg">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-secondary mt-4">
          {t('admin.common.retry')}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export function Pagination({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const t = useT();
  if (total === 0) return null;

  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-4 py-3"
      aria-label={t('admin.common.pagination')}
    >
      <p className="text-2xs text-fg-muted" aria-live="polite">
        {t('admin.common.pageOf')
          .replace('{page}', String(page))
          .replace('{pageCount}', String(pageCount))
          .replace('{total}', String(total))}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="btn-secondary px-2 py-1.5"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label={t('admin.common.previous')}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn-secondary px-2 py-1.5"
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount}
          aria-label={t('admin.common.next')}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Sortable column header
// ---------------------------------------------------------------------------

export function SortHeader({
  label,
  field,
  sort,
  order,
  onSort,
  className = '',
}: {
  label: string;
  field: string;
  sort: string;
  order: 'asc' | 'desc';
  onSort: (field: string) => void;
  className?: string;
}) {
  const active = sort === field;
  return (
    <th scope="col" className={`px-3 py-2 text-left font-medium ${className}`} aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className="inline-flex items-center gap-1 rounded text-fg-muted transition-colors hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {label}
        <span aria-hidden="true" className={active ? 'text-accent-fg' : 'text-fg-subtle/40'}>
          {active ? (order === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

type Toast = { id: number; message: string; tone: 'success' | 'error' };
const ToastContext = createContext<((message: string, tone?: 'success' | 'error') => void) | null>(null);

export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error('useToast must be used inside <ToastProvider>');
  return push;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((toast) => toast.id !== id)), 5000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/*
        role="status" + aria-live="polite" rather than "alert": these announce
        the result of an action the operator just took, so interrupting them
        mid-sentence would be rude. Errors still reach a screen reader, just
        at the next natural pause.
      */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`overlay pointer-events-auto flex items-start gap-2 px-3.5 py-2.5 text-sm ${
              toast.tone === 'error' ? 'border-danger/40 text-danger-fg' : 'text-fg'
            }`}
          >
            {toast.tone === 'error' ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-verified-fg" aria-hidden="true" />
            )}
            <span className="flex-1">{toast.message}</span>
            <button
              type="button"
              onClick={() => setToasts((prev) => prev.filter((item) => item.id !== toast.id))}
              className="rounded p-0.5 text-fg-subtle hover:text-fg"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

/**
 * Modal confirmation for actions that change or destroy an account.
 *
 * Three things make this a real confirmation rather than a speed bump:
 *
 *  1. A REASON IS MANDATORY when `requireReason` is set. It is not decoration -
 *     it lands in ModerationAction.reason and in the audit row, so six months
 *     later "why is this account suspended" has an answer.
 *  2. TYPE-TO-CONFIRM for deletion. Echoing the nickname back is the only
 *     safeguard that survives a mis-aimed click on the wrong table row, and the
 *     server re-checks it so a scripted client cannot skip it.
 *  3. Focus is moved into the dialog and Escape closes it. A modal that traps
 *     nothing and announces nothing is invisible to a keyboard operator.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = 'danger',
  requireReason = false,
  typeToConfirm,
  busy = false,
  extra,
  extraValid = true,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  requireReason?: boolean;
  /** When set, the operator must type this exact string to enable Confirm. */
  typeToConfirm?: string;
  busy?: boolean;
  /**
   * Extra fields for actions that need one more decision than a reason - the
   * role on an approval, the duration on a freeze.
   *
   * A slot rather than a second dialog component: the focus trap, the Escape
   * handling, the reason validation and the busy state are the hard parts and
   * they are already correct here. Forking this to add a <select> would mean
   * maintaining that behaviour twice, and the copy is where it would rot.
   */
  extra?: ReactNode;
  /** Gates Confirm on the extra fields being satisfied. */
  extraValid?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setReason('');
      setTyped('');
      return;
    }
    // Return focus to where it came from, or the operator is dumped at the top
    // of the document after every action.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    firstFieldRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onCancel();
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea, input, [href]',
      );
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
      previouslyFocused?.focus?.();
    };
  }, [open, busy, onCancel]);

  const reasonOk = !requireReason || reason.trim().length >= 10;
  const typedOk = !typeToConfirm || typed.trim() === typeToConfirm;
  const canConfirm = reasonOk && typedOk && extraValid && !busy;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="overlay w-full max-w-md p-5"
      >
        <h2 id={titleId} className="text-base font-semibold text-fg">
          {title}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{body}</p>

        {requireReason && (
          <label className="mt-4 block">
            <span className="text-2xs font-medium text-fg-muted">{t('admin.common.reason')}</span>
            <textarea
              ref={firstFieldRef as React.RefObject<HTMLTextAreaElement>}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              minLength={10}
              maxLength={1000}
              className="input mt-1 resize-y"
              placeholder={t('admin.common.reasonHint')}
            />
            {!reasonOk && reason.length > 0 && (
              <span className="mt-1 block text-2xs text-danger-fg">
                {t('admin.common.reasonTooShort')}
              </span>
            )}
          </label>
        )}

        {extra && <div className="mt-4 space-y-3">{extra}</div>}

        {typeToConfirm && (
          <label className="mt-4 block">
            <span className="text-2xs font-medium text-fg-muted">
              {t('admin.common.typeToConfirm').replace('{value}', typeToConfirm)}
            </span>
            <input
              ref={requireReason ? undefined : (firstFieldRef as React.RefObject<HTMLInputElement>)}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className="input mt-1 font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            {t('admin.common.cancel')}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'btn-danger' : 'btn-primary'}
            onClick={() => onConfirm(reason.trim())}
            disabled={!canConfirm}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export type AsyncState<T> = { data: T | null; error: string | null; loading: boolean };

/**
 * Minimal fetch hook for admin screens.
 *
 * The project already ships @tanstack/react-query, but it is not wired into a
 * provider anywhere in the app yet. Adding one at the root for the back office
 * alone would change the render tree for every student-facing page, so this
 * covers the panel's needs - load, reload, cancel on unmount - in a few lines
 * and stays trivial to replace with useQuery the day a provider exists.
 */
export function useAdminFetch<T>(url: string): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: null }));

    fetch(url, { signal: controller.signal, credentials: 'same-origin' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? 'errors.generic');
        return body as T;
      })
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error: Error) => {
        if (error.name === 'AbortError') return;
        setState({ data: null, error: error.message, loading: false });
      });

    return () => controller.abort();
  }, [url, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return useMemo(() => ({ ...state, reload }), [state, reload]);
}

/** Formats an ISO timestamp for a dense table. Locale-independent on purpose. */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
