'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/LocaleProvider';
import type { PublicStats } from '@/lib/stats/public';

/**
 * Counts 0 -> target once scrolled into view.
 *
 * Two details that separate this from the usual setInterval version: it is
 * driven by requestAnimationFrame with an ease-out curve so the numbers
 * decelerate rather than tick linearly, and it jumps straight to the value
 * under prefers-reduced-motion. An animated counter is decoration, and
 * decoration must not move for someone who asked the OS for no motion.
 */
function useCountUp(target: number, durationMs = 1400) {
  const [value, setValue] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || started.current) return;
        started.current = true;

        const start = performance.now();
        const tick = (now: number) => {
          const progress = Math.min(1, (now - start) / durationMs);
          const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
          setValue(Math.round(target * eased));
          if (progress < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [target, durationMs]);

  return { ref, value };
}

/**
 * A bordered list, not a dark marketing slab.
 *
 * The previous version was a full-width slate-950 panel with a radial indigo
 * wash and 4xl numerals — the visual equivalent of shouting. This says the
 * same thing at 20px inside the page's own grid, which is both calmer and
 * more credible.
 */
export function StatsRow({ stats }: { stats: PublicStats }) {
  const t = useT();
  const rows = [
    { key: 'students', value: stats.students },
    { key: 'notes', value: stats.notes },
    { key: 'hours', value: stats.mentorHours },
    { key: 'universities', value: stats.universities },
  ];

  return (
    <dl className="divide-y divide-edge rounded-xl border border-edge bg-surface">
      {rows.map((stat) => (
        <StatItem key={stat.key} target={stat.value} label={t(`landing.stats.${stat.key}`)} />
      ))}
    </dl>
  );
}

/** `null` is an unreadable stat: shown as a dash rather than a false zero. */
function StatItem({ target, label }: { target: number | null; label: string }) {
  const { ref, value } = useCountUp(target ?? 0);

  return (
    <div ref={ref} className="flex items-baseline justify-between gap-4 px-4 py-3">
      {/* min-w-0 + leading-snug: AZ and RU labels here run up to twice the
          length of the English ones and must wrap, not clip. */}
      <dt className="min-w-0 text-xs leading-snug text-fg-muted">{label}</dt>
      <dd className="tabular shrink-0 text-xl font-medium text-fg">
        {target === null ? '—' : value.toLocaleString()}
      </dd>
    </div>
  );
}
