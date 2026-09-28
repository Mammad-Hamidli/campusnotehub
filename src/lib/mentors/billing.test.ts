import { describe, expect, it } from 'vitest';
import { billingSnapshot } from './billing';

/** An instant at local noon in Baku (UTC+4, no DST), so the date is unambiguous. */
const baku = (date: string, time = '12:00') => new Date(`${date}T${time}:00+04:00`);

describe('billingSnapshot - first payment one month after joining', () => {
  it('puts the first due date exactly one calendar month after the join date', () => {
    const snap = billingSnapshot(baku('2026-03-15'), baku('2026-03-15'));
    expect(snap).toMatchObject({ joinedOn: '2026-03-15', nextDueOn: '2026-04-15', daysLeft: 31, cycle: 1 });
    expect(snap.urgency).toBe('upcoming');
  });

  it('keeps the first cycle while the joining month is still running', () => {
    expect(billingSnapshot(baku('2026-03-15'), baku('2026-03-31'))).toMatchObject({
      nextDueOn: '2026-04-15',
      cycle: 1,
    });
  });

  it('reports 0 days and "today" on the due date itself', () => {
    expect(billingSnapshot(baku('2026-03-15'), baku('2026-04-15', '23:59'))).toMatchObject({
      nextDueOn: '2026-04-15',
      daysLeft: 0,
      cycle: 1,
      urgency: 'today',
    });
  });

  it('moves to the next month the day after a due date', () => {
    expect(billingSnapshot(baku('2026-03-15'), baku('2026-04-16'))).toMatchObject({
      nextDueOn: '2026-05-15',
      cycle: 2,
    });
  });

  it('flags the last week before the due date as "soon"', () => {
    expect(billingSnapshot(baku('2026-03-15'), baku('2026-04-08'))).toMatchObject({ daysLeft: 7, urgency: 'soon' });
    expect(billingSnapshot(baku('2026-03-15'), baku('2026-04-07'))).toMatchObject({ daysLeft: 8, urgency: 'upcoming' });
  });

  it('crosses a year boundary', () => {
    expect(billingSnapshot(baku('2025-12-20'), baku('2026-01-05'))).toMatchObject({
      nextDueOn: '2026-01-20',
      cycle: 1,
    });
  });
});

describe('billingSnapshot - short months clamp without drifting', () => {
  it('falls on the last day of February for a 31st join date', () => {
    expect(billingSnapshot(baku('2026-01-31'), baku('2026-02-10')).nextDueOn).toBe('2026-02-28');
    expect(billingSnapshot(baku('2028-01-31'), baku('2028-02-10')).nextDueOn).toBe('2028-02-29');
  });

  it('returns to the 31st after February rather than staying on the 28th', () => {
    expect(billingSnapshot(baku('2026-01-31'), baku('2026-03-01'))).toMatchObject({
      nextDueOn: '2026-03-31',
      cycle: 2,
    });
  });

  it('clamps a 31st to the 30th in a 30-day month', () => {
    expect(billingSnapshot(baku('2026-03-31'), baku('2026-04-02')).nextDueOn).toBe('2026-04-30');
  });
});

describe('billingSnapshot - calendar dates are Baku dates', () => {
  it('dates a 01:30 Baku join on the Baku day, not the UTC one', () => {
    // 2026-03-14T21:30Z is already 15 March in Baku.
    const snap = billingSnapshot(new Date('2026-03-14T21:30:00Z'), baku('2026-03-20'));
    expect(snap.joinedOn).toBe('2026-03-15');
    expect(snap.nextDueOn).toBe('2026-04-15');
  });

  it('counts "today" in Baku when UTC is still on the previous day', () => {
    // 2026-04-14T21:00Z is 01:00 on 15 April in Baku - the due date.
    expect(billingSnapshot(baku('2026-03-15'), new Date('2026-04-14T21:00:00Z')).daysLeft).toBe(0);
  });

  it('never schedules a payment before one month has passed, even with a future join date', () => {
    expect(billingSnapshot(baku('2026-05-10'), baku('2026-05-01'))).toMatchObject({
      nextDueOn: '2026-06-10',
      cycle: 1,
    });
  });
});
