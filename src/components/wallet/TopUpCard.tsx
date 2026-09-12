'use client';

import { useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

const QUICK_AMOUNTS = [5, 10, 20, 50];
const MIN_AZN = 1;
const MAX_AZN = 500;

function newAttemptKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * "Add balance".
 *
 * Posts to /api/wallet/top-up, which records a double-entry ledger
 * transaction and credits the wallet atomically. The idempotency key is kept
 * per ATTEMPT, so a double click or a retried request after a network blip
 * credits once; it is only renewed after a completed top-up.
 *
 * The payment step behind it is a placeholder until a card processor is
 * integrated, which the hint under the button says plainly.
 */
export function TopUpCard({ disabled = false, onDone }: { disabled?: boolean; onDone: () => void }) {
  const t = useT();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const attemptKey = useRef(newAttemptKey());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const value = Number(amount.replace(',', '.'));
    if (!Number.isFinite(value) || value < MIN_AZN || value > MAX_AZN) {
      setError(t('wallet.topUpForm.errors.amount', { min: MIN_AZN, max: MAX_AZN }));
      return;
    }
    const amountMinor = Math.round(value * 100);

    setBusy(true);
    try {
      const response = await fetch('/api/wallet/top-up', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountMinor, idempotencyKey: attemptKey.current }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(t(payload.error ?? 'errors.generic', { min: MIN_AZN, max: MAX_AZN }));
        return;
      }
      attemptKey.current = newAttemptKey();
      setAmount('');
      setSuccess(t('wallet.topUpForm.success', { amount: value.toFixed(2) }));
      onDone();
    } catch {
      setError(t('errors.network'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card mt-4 p-4">
      <h2 className="text-sm font-semibold text-fg">{t('wallet.topUpForm.title')}</h2>
      <p className="mt-0.5 text-2xs text-fg-muted">{t('wallet.topUpForm.hint', { min: MIN_AZN, max: MAX_AZN })}</p>

      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex min-w-[9rem] flex-1 flex-col gap-1">
          <span className="text-2xs font-medium text-fg-muted">{t('wallet.topUpForm.amount')}</span>
          <input
            type="number"
            inputMode="decimal"
            min={MIN_AZN}
            max={MAX_AZN}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={disabled || busy}
            className="input py-1.5 text-sm"
            placeholder="10.00"
          />
        </label>
        <div className="flex gap-1.5">
          {QUICK_AMOUNTS.map((quick) => (
            <button
              key={quick}
              type="button"
              disabled={disabled || busy}
              onClick={() => setAmount(String(quick))}
              className="btn-secondary px-2.5 py-1.5 text-sm"
            >
              {quick} ₼
            </button>
          ))}
        </div>
        <button type="submit" disabled={disabled || busy} className="btn-primary px-3 py-1.5 text-sm">
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Plus className="h-4 w-4" aria-hidden="true" />
          )}
          {t('wallet.topUpForm.submit')}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-2 text-sm text-danger-fg">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="mt-2 text-sm text-verified">
          {success}
        </p>
      )}
      <p className="mt-2 text-2xs text-fg-subtle">{t('wallet.topUpForm.providerNote')}</p>
    </section>
  );
}
