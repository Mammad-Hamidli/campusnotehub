import { describe, expect, it } from 'vitest';
import type { NotificationRecord } from '@/lib/firebase/repositories/notifications';
import { serializeNotification } from './serialize';

const row = (linkUrl: string | null): NotificationRecord => ({
  id: 'n1',
  userId: 'u1',
  type: 'BOOKING_REQUESTED',
  titleKey: 'notifications.types.BOOKING_REQUESTED',
  bodyKey: 'mentors.booking.summary',
  params: null,
  linkUrl,
  readAt: null,
  createdAt: new Date('2026-10-01T10:00:00Z'),
});

describe('serializeNotification', () => {
  it('sends a legacy /bookings row to the mentor panel request list', () => {
    for (const legacy of ['/bookings', '/bookings?mentor=m1', '/bookings/abc']) {
      expect(serializeNotification(row(legacy)).linkUrl).toBe('/mentors/dashboard#requests');
    }
  });

  it('leaves every other link alone', () => {
    for (const link of ['/sessions/abc', '/bookingsx', '/mentors/m1', null]) {
      expect(serializeNotification(row(link)).linkUrl).toBe(link);
    }
  });
});
