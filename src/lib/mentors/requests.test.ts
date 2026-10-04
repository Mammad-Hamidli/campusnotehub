import { describe, expect, it } from 'vitest';
import { bookingIdFor, meetEventIdFor } from './ids';
import {
  holdsSlot,
  isLapsedRequest,
  isMeetUrl,
  isPendingRequest,
  joinState,
  requestExpiresAt,
  respondSchema,
} from './requests';

const now = new Date('2026-10-04T10:00:00Z');
const hours = (h: number) => new Date(now.getTime() + h * 3_600_000);

describe('requestExpiresAt', () => {
  it('gives a far-off session the full 48 hours', () => {
    expect(requestExpiresAt(now, hours(24 * 7))).toEqual(hours(48));
  });

  it('closes a near session one hour before it starts', () => {
    expect(requestExpiresAt(now, hours(5))).toEqual(hours(4));
  });

  it('refuses a session too close to leave a real answer window', () => {
    // Starts in 70 minutes: the deadline would be 10 minutes away.
    expect(requestExpiresAt(now, new Date(now.getTime() + 70 * 60_000))).toBeNull();
  });
});

describe('lapsed requests', () => {
  const request = { status: 'REQUESTED', startsAt: hours(30), requestExpiresAt: hours(2) };

  it('holds the slot until the deadline, then lets it go', () => {
    expect(holdsSlot(request, now)).toBe(true);
    expect(isPendingRequest(request, now)).toBe(true);
    expect(isLapsedRequest(request, hours(2))).toBe(true);
    expect(holdsSlot(request, hours(2))).toBe(false);
  });

  it('falls back to one hour before the start when no deadline was stored', () => {
    const legacy = { status: 'REQUESTED', startsAt: hours(3), requestExpiresAt: null };
    expect(isLapsedRequest(legacy, hours(1.9))).toBe(false);
    expect(isLapsedRequest(legacy, hours(2))).toBe(true);
  });

  it('never lapses a confirmed booking', () => {
    expect(holdsSlot({ status: 'CONFIRMED', startsAt: hours(1), requestExpiresAt: hours(-5) }, now)).toBe(true);
  });

  it('frees the slot of a declined or expired booking', () => {
    expect(holdsSlot({ status: 'REJECTED', startsAt: hours(5) }, now)).toBe(false);
    expect(holdsSlot({ status: 'EXPIRED', startsAt: hours(5) }, now)).toBe(false);
  });
});

describe('joinState', () => {
  const session = { startsAt: hours(1), endsAt: hours(2) };

  it('is early until 30 minutes before the start', () => {
    expect(joinState(session, new Date(hours(1).getTime() - 31 * 60_000))).toBe('early');
    expect(joinState(session, new Date(hours(1).getTime() - 30 * 60_000))).toBe('open');
  });

  it('stays open 15 minutes past the end, then closes', () => {
    expect(joinState(session, new Date(hours(2).getTime() + 15 * 60_000))).toBe('open');
    expect(joinState(session, new Date(hours(2).getTime() + 16 * 60_000))).toBe('closed');
  });
});

describe('ids', () => {
  it('maps a retried submit to the same booking', () => {
    expect(bookingIdFor('u1', 'k1')).toBe(bookingIdFor('u1', 'k1'));
    expect(bookingIdFor('u1', 'k1')).not.toBe(bookingIdFor('u2', 'k1'));
  });

  it('derives a calendar event id Google accepts (base32hex, 5-1024 chars)', () => {
    const id = meetEventIdFor(bookingIdFor('u1', 'k1'));
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(meetEventIdFor('b1')).toBe(meetEventIdFor('b1'));
  });
});

describe('isMeetUrl', () => {
  it('accepts a Meet room', () => {
    expect(isMeetUrl('https://meet.google.com/abc-defg-hij')).toBe(true);
  });

  it.each([
    'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com.evil.example/abc-defg-hij',
    'https://evil.example/https://meet.google.com/abc',
    'https://meet.google.com/abc-defg-hij/../../x',
    'javascript:alert(1)',
    42,
  ])('rejects %s', (value) => {
    expect(isMeetUrl(value)).toBe(false);
  });
});

describe('respondSchema', () => {
  it('accepts a bare accept', () => {
    expect(respondSchema.safeParse({ action: 'accept' }).success).toBe(true);
  });

  it('requires a real reason to decline', () => {
    expect(respondSchema.safeParse({ action: 'reject' }).success).toBe(false);
    expect(respondSchema.safeParse({ action: 'reject', reason: '   no    ' }).success).toBe(false);
    expect(respondSchema.safeParse({ action: 'reject', reason: 'I am travelling that week.' }).success).toBe(true);
  });

  it('rejects unknown fields and actions', () => {
    expect(respondSchema.safeParse({ action: 'accept', reason: 'x' }).success).toBe(false);
    expect(respondSchema.safeParse({ action: 'maybe' }).success).toBe(false);
  });
});
