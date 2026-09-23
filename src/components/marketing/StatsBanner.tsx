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
 * Four live numbers as tiles under the hero (real numbers - see
 * stats/public.ts).
 *
 * Each tile used to carry its own hue: orange, pink, violet, sky. Four
 * numbers in four colours implies the colours encode something, and they did
 * not - the tiles are one homogeneous set of counts. They now alternate brand
 * and accent, which keeps the row from looking like a spreadsheet without
 * pretending the tiles differ in kind.
 */
const TONES = ['text-brand', 'text-accent', 'text-brand', 'text-accent'] as const;

export function StatsRow({ stats }: { stats: PublicStats }) {
  const t = useT();
  const rows = [
    { key: 'students', value: stats.students },
    { key: 'notes', value: stats.notes },
    { key: 'hours', value: stats.mentorHours },
    { key: 'universities', value: stats.universities },
  ];

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {rows.map((stat, i) => (
        <StatItem key={stat.key} target={stat.value} label={t(`landing.stats.${stat.key}`)} tone={TONES[i]} />
      ))}
    </dl>
  );
}

/** `null` is an unreadable stat: shown as a dash rather than a false zero. */
function StatItem({ target, label, tone }: { target: number | null; label: string; tone: string }) {
  const { ref, value } = useCountUp(target ?? 0);

  return (
    <div ref={ref} className="flex flex-col-reverse gap-1 rounded-2xl border border-edge bg-surface/80 px-4 py-3.5 backdrop-blur">
      {/* min-w-0 + leading-snug: AZ and RU labels run up to twice the length
          of the English ones and must wrap, not clip. */}
      <dt className="min-w-0 text-xs leading-snug text-fg-muted">{label}</dt>
      <dd className={`tabular text-2xl font-extrabold ${tone}`}>
        {target === null ? '—' : value.toLocaleString()}
      </dd>
    </div>
  );
}
