'use client';

import { Clock, Eye, ShieldCheck, Trash2 } from 'lucide-react';
import { useT } from '@/lib/i18n/LocaleProvider';

/**
 * The "we do not keep your documents" panel.
 *
 * This sits directly above the four upload slots, not behind a link or a
 * tooltip. Asking a 19-year-old to photograph their national ID is the single
 * biggest drop-off point in the funnel, and the reason they hesitate is not
 * that the form is confusing - it is that they do not know what happens to the
 * image. Answering that on the same screen as the request is worth more than
 * any amount of visual polish elsewhere in the flow.
 *
 * Every claim here is one the architecture actually keeps, and each maps to a
 * specific mechanism:
 *
 * "never stored"      -> no S3 bucket exists for KYC; buffers are wiped in a
 *                          finally block (src/lib/verification/pipeline.ts)
 * "deleted instantly" -> the pipeline is synchronous; nothing is queued
 * "only a yes/no"     -> the User table holds booleans and timestamps only
 *                          (see the schema comment on the verification block)
 * "a person may look" -> the honest caveat: flagged cases go to a moderator,
 *                          with the documents held encrypted for at most 24h
 *
 * That fourth line matters. Claiming "no human ever sees it" would be a lie,
 * because the hybrid pipeline requires a human for ambiguous cases. Users
 * forgive a caveat; they do not forgive discovering one later.
 */
export function ZeroRetentionNotice() {
  const t = useT();

  const points = [
    { icon: Trash2, key: 'deleted' },
    { icon: ShieldCheck, key: 'flagsOnly' },
    { icon: Eye, key: 'humanReview' },
    { icon: Clock, key: 'window' },
  ] as const;

  return (
    <section
      aria-labelledby="retention-heading"
      className="rounded-xl border border-verified/30 bg-verified-soft/60 p-4"
    >
      <div className="flex items-start gap-2.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-verified"
          aria-hidden="true"
        >
          <ShieldCheck className="h-[1.05rem] w-[1.05rem] text-accent-fg" />
        </span>
        <div className="min-w-0">
          <h2 id="retention-heading" className="text-sm font-semibold leading-snug text-verified-fg">
            {t('register.retention.title')}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-verified-fg">
            {t('register.retention.lead')}
          </p>
        </div>
      </div>

      <ul className="mt-3.5 grid gap-2 sm:grid-cols-2">
        {points.map(({ icon: Icon, key }) => (
          <li
            key={key}
            className="flex items-start gap-2 rounded-lg bg-surface/70 px-3 py-2 text-xs
 leading-snug text-fg"
          >
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-verified" aria-hidden="true" />
            <span className="min-w-0">{t(`register.retention.${key}`)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
