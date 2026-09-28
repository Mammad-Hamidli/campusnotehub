import Link from 'next/link';
import { Check, Circle, Clock, type LucideIcon } from 'lucide-react';
import type { ChecklistStep, ChecklistStepState } from '@/lib/mentors/checklist';
import type { Translate } from './format';

const STATE: Record<ChecklistStepState, { icon: LucideIcon; tone: string }> = {
  done: { icon: Check, tone: 'bg-verified-soft text-verified' },
  current: { icon: Circle, tone: 'bg-accent-soft text-accent' },
  waiting: { icon: Clock, tone: 'bg-warn-soft text-warn' },
  locked: { icon: Circle, tone: 'bg-surface-inset text-fg-subtle' },
};

/**
 * The road from "account created" to "bookable": email, identity, the
 * application, approval. Each step says where it stands and links to the one
 * page that moves it. The states come from buildMentorChecklist() over live
 * data, so a step is never ticked on a guess.
 */
export function OnboardingChecklist({ steps, t }: { steps: ChecklistStep[]; t: Translate }) {
  const done = steps.filter((s) => s.state === 'done').length;

  return (
    <section className="card p-5" aria-labelledby="mentor-checklist-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="mentor-checklist-title" className="text-sm font-semibold text-fg">
          {t('mentorDashboard.checklist.title')}
        </h2>
        <span className="text-xs text-fg-muted">
          {t('mentorDashboard.checklist.progress', { done, total: steps.length })}
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-inset" aria-hidden="true">
        <div className="h-full rounded-full bg-accent" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>

      <ol className="mt-4 space-y-1">
        {steps.map((step) => {
          const { icon: Icon, tone } = STATE[step.state];
          return (
            <li
              key={step.key}
              className={`flex items-start gap-3 rounded-lg p-2.5 ${step.state === 'current' ? 'bg-surface-muted' : ''}`}
            >
              <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${tone}`}>
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${step.state === 'done' ? 'text-fg-muted line-through decoration-edge-strong' : 'text-fg'}`}>
                  {t(`mentorDashboard.checklist.${step.key}.title`)}
                  <span className="sr-only"> - {t(`mentorDashboard.checklist.state.${step.state}`)}</span>
                </p>
                {step.state !== 'done' && (
                  <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                    {t(`mentorDashboard.checklist.${step.key}.${step.state}`)}
                  </p>
                )}
                {step.note && (
                  <p className="mt-1.5 rounded-md bg-danger-soft px-2 py-1 text-xs text-danger-fg">
                    {t('mentorDashboard.checklist.moderatorNote', { reason: step.note })}
                  </p>
                )}
              </div>
              {step.href && (step.state === 'current' || step.state === 'waiting') && (
                <Link href={step.href} className="btn-secondary shrink-0 px-3 py-1.5 text-xs">
                  {t(`mentorDashboard.checklist.${step.key}.cta`)}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
