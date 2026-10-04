'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';
import { useToast } from '@/components/ui/Feedback';

/**
 * Connect / disconnect buttons for the mentor panel's Google Calendar card.
 * Connecting asks the server to start the consent flow (POST answers the
 * Google URL and sets the binding cookie), then navigates there; Google
 * returns to the panel with ?calendar=connected or ?oauth=<reason>.
 */
export function CalendarConnection({ connected }: { connected: boolean }) {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    try {
      const response = await fetch('/api/integrations/google-calendar', { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !body.url) {
        toast.error(t(body.error ?? 'errors.generic'));
        setBusy(false);
        return;
      }
      window.location.assign(body.url);
    } catch {
      toast.error(t('errors.network'));
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm(t('mentors.calendar.disconnectConfirm'))) return;
    setBusy(true);
    try {
      const response = await fetch('/api/integrations/google-calendar', { method: 'DELETE' });
      if (!response.ok) {
        toast.error(t('errors.generic'));
        return;
      }
      toast.success(t('mentors.calendar.disconnected'));
      router.refresh();
    } catch {
      toast.error(t('errors.network'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => void connect()} className="btn-primary px-3.5 py-1.5 text-sm">
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        {t(connected ? 'mentors.calendar.reconnect' : 'mentors.calendar.connect')}
      </button>
      {connected && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void disconnect()}
          className="btn-secondary px-3.5 py-1.5 text-sm"
        >
          {t('mentors.calendar.disconnect')}
        </button>
      )}
    </div>
  );
}
