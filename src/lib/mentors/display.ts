import { MentorIndustry } from '@/lib/enums';

/**
 * Presentation helpers shared by every mentor surface (directory, profile,
 * application form, the feed ad). Client-safe: no server imports.
 */

/** Every industry, in picker order - the enum the server validates against. */
export const MENTOR_INDUSTRIES = Object.values(MentorIndustry);

/** The translated industry name; a code the enum no longer has shows as-is. */
export function industryLabel(t: (key: string) => string, industry: string): string {
  return industry in MentorIndustry ? t(`mentors.industries.${industry}`) : industry.replace(/_/g, ' ');
}

/**
 * Hourly rate, from qepik (minor units) - never formatted from a float.
 * Null for a free mentor. Call only in client-rendered output: Node and
 * Chromium format az currency differently (hydration mismatch).
 */
export function formatRate(minor: number, locale: string): string | null {
  if (minor <= 0) return null;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'AZN' }).format(minor / 100);
}
