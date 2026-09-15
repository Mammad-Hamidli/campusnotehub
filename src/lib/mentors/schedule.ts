import { z } from 'zod';

/**
 * Weekly availability grid <-> stored rules. Client-safe (no server imports):
 * the grid UI, the apply route and the settings route share one definition.
 *
 * Storage is unchanged: `mentorProfiles/{id}/availability` rules of
 * { weekday 0=Sun..6, startMinute, endMinute } in the mentor's timezone, which
 * getDaySlots() already consumes. The grid is a 30-minute bitmap over it.
 */
export const SLOT_MINUTES = 30;
export const GRID_START_MINUTE = 7 * 60;
export const GRID_END_MINUTE = 23 * 60;
/** Monday-first display order. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

export type WeeklyRule = { weekday: number; startMinute: number; endMinute: number };
export type BlockedDate = { date: string; startMinute: number | null; endMinute: number | null };

export const cellKey = (weekday: number, minute: number) => `${weekday}:${minute}`;

export function rulesToCells(rules: WeeklyRule[]): Set<string> {
  const cells = new Set<string>();
  for (const r of rules) {
    const from = Math.floor(r.startMinute / SLOT_MINUTES) * SLOT_MINUTES;
    for (let m = from; m < r.endMinute; m += SLOT_MINUTES) cells.add(cellKey(r.weekday, m));
  }
  return cells;
}

/** Merges contiguous cells into the fewest rules. Idempotent, order-stable. */
export function cellsToRules(cells: Iterable<string>): WeeklyRule[] {
  const byDay = new Map<number, number[]>();
  for (const key of cells) {
    const [day, minute] = key.split(':').map(Number);
    byDay.set(day, [...(byDay.get(day) ?? []), minute]);
  }
  const rules: WeeklyRule[] = [];
  for (const [weekday, minutes] of [...byDay].sort((a, b) => a[0] - b[0])) {
    minutes.sort((a, b) => a - b);
    let start = minutes[0];
    let end = start + SLOT_MINUTES;
    for (const m of minutes.slice(1)) {
      if (m === end) end += SLOT_MINUTES;
      else if (m > end) {
        rules.push({ weekday, startMinute: start, endMinute: end });
        start = m;
        end = m + SLOT_MINUTES;
      }
    }
    rules.push({ weekday, startMinute: start, endMinute: end });
  }
  return rules;
}

export const minuteLabel = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// ---------------------------------------------------------------- validation

const minute = z
  .number()
  .int()
  .min(0)
  .max(1440)
  .refine((m) => m % SLOT_MINUTES === 0, 'errors.validationFailed');

/** Overlapping / unsorted input is normalised, not rejected. */
export const weeklyRulesSchema = z
  .array(
    z
      .object({ weekday: z.number().int().min(0).max(6), startMinute: minute, endMinute: minute })
      .refine((r) => r.endMinute > r.startMinute),
  )
  .max(336)
  .transform((rules) => cellsToRules(rulesToCells(rules)));

export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'errors.validationFailed');

export const blockedDatesSchema = z
  .array(
    z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startMinute: minute.nullable(),
        endMinute: minute.nullable(),
      })
      .refine(
        (b) =>
          (b.startMinute === null) === (b.endMinute === null) &&
          (b.startMinute === null || b.endMinute! > b.startMinute),
      ),
  )
  .max(60);
