'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, FileText, ShoppingBag } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * The buyer's purchase history.
 *
 * Replaces a StubPage. This is the other half of the purchase flow: without it
 * a paid note is unreachable, because the download endpoint is authorization-
 * gated per request and nothing else links to it.
 *
 * The download is a plain <a> to /api/notes/:id/file rather than a fetch +
 * object URL. That route already re-checks the order server-side and sets
 * Content-Disposition, so letting the browser handle it gives a real download
 * with a real filename and no multi-megabyte buffer in JS memory.
 */

type Order = {
  id: string;
  status: string;
  priceMinor: number;
  currency: string;
  paidAt: string | null;
  createdAt: string;
  downloadable: boolean;
  note: {
    id: string;
    title: string;
    subject: string;
    courseCode: string | null;
    pageCount: number | null;
    university: { code: string } | null;
    seller: { nickname: string; isVerified: boolean };
    attachment: { fileName: string; mime: string; sizeBytes: number } | null;
  };
};

function money(minor: number, currency: string, locale: string): string {
  if (minor === 0) return '—';
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currency || 'AZN' }).format(
    minor / 100,
  );
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PurchasesList() {
  const t = useT();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const locale = typeof document !== 'undefined' ? document.documentElement.lang || 'az' : 'az';

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const response = await fetch('/api/notes/purchases', { signal });
      if (!response.ok) {
        setError('errors.generic');
        setOrders([]);
        return;
      }
      const data = await response.json();
      setOrders(data.orders ?? []);
    } catch (cause) {
      if ((cause as Error)?.name === 'AbortError') return;
      setError('errors.generic');
      setOrders([]);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <Link href="/notes" className="btn-ghost -ml-2 px-2 py-1 text-sm">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {t('notes.title')}
      </Link>

      <header className="mb-5 mt-3">
        <h1 className="text-xl font-bold tracking-tight text-fg">{t('notes.myPurchases')}</h1>
        <p className="mt-0.5 text-sm text-fg-muted">{t('notes.purchases.subtitle')}</p>
      </header>

      {orders === null ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-24 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-fg-muted">{t(error)}</p>
          <button type="button" onClick={() => void load()} className="btn-secondary mt-3 px-3 py-1.5 text-sm">
            {t('common.retry')}
          </button>
        </div>
      ) : orders.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft">
            <ShoppingBag className="h-6 w-6 text-accent" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-fg">{t('notes.purchases.empty')}</h2>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-fg-muted">
            {t('notes.purchases.emptyHint')}
          </p>
          <Link href="/notes" className="btn-primary mt-4">
            {t('notes.purchases.browse')}
          </Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {orders.map((order) => (
            <li key={order.id} className="card p-4">
              <div className="flex flex-wrap items-start gap-3">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-inset"
                  aria-hidden="true"
                >
                  <FileText className="h-5 w-5 text-fg-subtle" />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{order.note.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-muted">
                    <span>{order.note.subject}</span>
                    {order.note.courseCode && <span>· {order.note.courseCode}</span>}
                    {order.note.university && <span>· {order.note.university.code}</span>}
                    <span>· @{order.note.seller.nickname}</span>
                  </p>
                  {order.note.attachment && (
                    <p className="mt-0.5 text-2xs text-fg-subtle">
                      {order.note.attachment.fileName} · {fileSize(order.note.attachment.sizeBytes)}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  <span className="tabular text-sm font-medium text-fg">
                    {money(order.priceMinor, order.currency, locale)}
                  </span>

                  {order.downloadable ? (
                    <a
                      href={`/api/notes/${order.note.id}/file`}
                      className="btn-primary px-3 py-1.5 text-xs"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('notes.purchases.download')}
                    </a>
                  ) : (
                    // A refunded order keeps its row for the ledger but no
                    // longer grants access - the server enforces that, and
                    // this says so rather than offering a link that 404s.
                    <span className="text-2xs text-fg-subtle">
                      {t('notes.purchases.refunded')}
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
