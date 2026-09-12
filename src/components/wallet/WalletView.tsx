'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowDownLeft, ArrowUpRight, Clock, Wallet as WalletIcon } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { TopUpCard } from './TopUpCard';

/**
 * The wallet.
 *
 * Replaces a StubPage. It exists because money now genuinely moves: buying a
 * note and booking a session both spend this balance, and a seller's earnings
 * land in it. Without a screen, a student had no way to see why a purchase was
 * refused for insufficient funds.
 *
 * ---------------------------------------------------------------------------
 * AVAILABLE AND PENDING ARE SHOWN SEPARATELY, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `pending` is money that has been earned but is still inside the seller
 * clearing window, so it cannot be spent or withdrawn yet. Adding the two into
 * a single headline number would tell someone they have funds they cannot
 * touch, and the first thing they would do is try to use them.
 *
 * Top-ups go through TopUpCard -> POST /api/wallet/top-up. The payment
 * capture behind it is a placeholder until a card processor is integrated
 * (see src/lib/wallet/topup.ts); the ledger posting, balance and history are
 * the real thing.
 */

type Entry = {
  id: string;
  amountMinor: number;
  currency: string;
  accountType: string;
  kind: string;
  description: string;
  createdAt: string;
};

type Wallet = {
  currency: string;
  availableMinor: number;
  pendingMinor: number;
  isFrozen: boolean;
};

function money(minor: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currency || 'AZN' }).format(
    minor / 100,
  );
}

function when(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WalletView() {
  const t = useT();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const locale = typeof document !== 'undefined' ? document.documentElement.lang || 'az' : 'az';

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/wallet', { signal });
      if (!response.ok) {
        setError('errors.generic');
        return;
      }
      const data = await response.json();
      setWallet(data.wallet);
      setEntries(data.entries ?? []);
    } catch (cause) {
      if ((cause as Error)?.name === 'AbortError') return;
      setError('errors.generic');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-5">
        <h1 className="text-xl font-bold tracking-tight text-fg">{t('wallet.title')}</h1>
        <p className="mt-0.5 text-sm text-fg-muted">{t('wallet.subtitle')}</p>
      </header>

      {loading ? (
        <div className="space-y-3" aria-busy="true">
          <div className="card h-28 animate-pulse" />
          <div className="card h-48 animate-pulse" />
        </div>
      ) : error || !wallet ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-fg-muted">{t(error ?? 'errors.generic')}</p>
          <button type="button" onClick={() => void load()} className="btn-secondary mt-3 px-3 py-1.5 text-sm">
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <section className="card p-4">
              <p className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-fg-subtle">
                <WalletIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {t('wallet.available')}
              </p>
              <p className="tabular mt-1.5 text-2xl font-bold text-fg">
                {money(wallet.availableMinor, wallet.currency, locale)}
              </p>
              <p className="mt-1 text-2xs text-fg-muted">{t('wallet.availableHint')}</p>
            </section>

            <section className="card p-4">
              <p className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-fg-subtle">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                {t('wallet.pending')}
              </p>
              <p className="tabular mt-1.5 text-2xl font-bold text-fg-muted">
                {money(wallet.pendingMinor, wallet.currency, locale)}
              </p>
              {/* Says WHY it is not spendable. "Pending" alone reads like a
                  delay rather than a deliberate refund window. */}
              <p className="mt-1 text-2xs text-fg-muted">{t('wallet.pendingNote')}</p>
            </section>
          </div>

          {wallet.isFrozen && (
            <p className="card mt-3 border-warn/30 bg-warn-soft p-3 text-sm text-warn-fg">
              {t('wallet.frozen')}
            </p>
          )}

          <TopUpCard disabled={wallet.isFrozen} onDone={() => void load()} />

          <section className="card mt-4 overflow-hidden">
            <h2 className="border-b border-edge px-4 py-3 text-sm font-semibold text-fg">
              {t('wallet.history')}
            </h2>

            {entries.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <p className="text-sm text-fg-muted">{t('wallet.empty')}</p>
                <Link href="/notes" className="btn-secondary mt-3 px-3 py-1.5 text-sm">
                  {t('notes.purchases.browse')}
                </Link>
              </div>
            ) : (
              <ul>
                {entries.map((entry) => {
                  const incoming = entry.amountMinor > 0;
                  return (
                    <li
                      key={entry.id}
                      className="flex items-center gap-3 border-b border-edge px-4 py-3 last:border-0"
                    >
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                          incoming ? 'bg-verified-soft text-verified' : 'bg-surface-inset text-fg-muted'
                        }`}
                        aria-hidden="true"
                      >
                        {incoming ? (
                          <ArrowDownLeft className="h-4 w-4" />
                        ) : (
                          <ArrowUpRight className="h-4 w-4" />
                        )}
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-fg">{entry.description}</p>
                        <p className="mt-0.5 text-2xs text-fg-subtle">
                          {t(`wallet.txn.${entry.kind}`)}
                          {entry.accountType === 'USER_PENDING' && ` · ${t('wallet.pending')}`}
                          {' · '}
                          {when(entry.createdAt, locale)}
                        </p>
                      </div>

                      <span
                        className={`tabular shrink-0 text-sm font-medium ${
                          incoming ? 'text-verified' : 'text-fg'
                        }`}
                      >
                        {incoming ? '+' : ''}
                        {money(entry.amountMinor, entry.currency, locale)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
