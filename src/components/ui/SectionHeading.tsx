import type { LucideIcon } from 'lucide-react';

/**
 * Page/section title with a tinted icon chip, shared by the listings so every
 * section announces itself the same way.
 *
 * `as` lets an embedded list demote itself to h2 on the dashboard without the
 * visual changing. The icon is decorative - the text is the heading.
 */
export function SectionHeading({
  icon: Icon,
  title,
  subtitle,
  as: Heading = 'h1',
  tone = 'text-accent bg-accent-soft',
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  as?: 'h1' | 'h2';
  tone?: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <Heading className="text-xl font-bold tracking-tight text-fg">{title}</Heading>
        {subtitle && <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p>}
      </div>
    </div>
  );
}
