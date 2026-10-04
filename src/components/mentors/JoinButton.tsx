'use client';

import { useEffect, useState } from 'react';
import { Video } from 'lucide-react';
import type { JoinState } from '@/lib/mentors/requests';

/**
 * "Join Google Meet", which switches itself on at the start of the join
 * window without a reload. Times arrive as epoch milliseconds and labels as
 * finished strings from the server, so nothing here formats a date (the az
 * hydration rule, see src/components/mentors/dashboard/format.ts).
 *
 * A plain <a>, never next/link: the target is an API route that redirects
 * off-site, and a prefetch must never touch it. The route re-checks the
 * window itself - this button is a convenience, not the control.
 */
export function JoinButton({
  href,
  opensAtMs,
  closesAtMs,
  initial,
  labels,
}: {
  href: string;
  opensAtMs: number;
  closesAtMs: number;
  initial: JoinState;
  labels: { join: string; early: string; closed: string };
}) {
  const [state, setState] = useState<JoinState>(initial);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      setState(now < opensAtMs ? 'early' : now <= closesAtMs ? 'open' : 'closed');
    };
    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => window.clearInterval(timer);
  }, [opensAtMs, closesAtMs]);

  if (state === 'open') {
    return (
      <a href={href} className="btn-primary px-4 py-2 text-sm" rel="noreferrer">
        <Video className="h-4 w-4" aria-hidden="true" />
        {labels.join}
      </a>
    );
  }
  return (
    <p className="rounded-lg border border-dashed border-edge px-3 py-2 text-sm text-fg-muted">
      {state === 'early' ? labels.early : labels.closed}
    </p>
  );
}
