import { describe, expect, it } from 'vitest';
import { groupSessionsByDevice, type GroupableSession } from './sessionGroups';

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1';

let seq = 0;
function row(deviceId: string | null, userAgent: string, lastSeenMinute: number): GroupableSession {
  seq += 1;
  return {
    id: `s${seq}`,
    deviceId,
    userAgent,
    authAt: new Date(Date.UTC(2026, 8, 25, 8, 0)),
    lastSeenAt: new Date(Date.UTC(2026, 8, 25, 9, lastSeenMinute)),
  };
}

const ids = (groups: { sessions: GroupableSession[] }[]) => groups.map((g) => g.sessions.map((s) => s.id));

describe('groupSessionsByDevice', () => {
  it('folds sessions of one recorded device into one row, newest first', () => {
    const a = row('dev1', CHROME_WIN, 1);
    const b = row('dev1', CHROME_WIN, 5);
    const c = row('dev2', SAFARI_IOS, 3);
    expect(ids(groupSessionsByDevice([a, b, c]))).toEqual([[b.id, a.id], [c.id]]);
  });

  it('keeps two devices apart even when their label and User-Agent match', () => {
    const a = row('dev1', CHROME_WIN, 1);
    const b = row('dev2', CHROME_WIN, 2);
    expect(groupSessionsByDevice([a, b])).toHaveLength(2);
  });

  it('folds a session with no deviceId into the one device with the same User-Agent', () => {
    const a = row('dev1', CHROME_WIN, 1);
    const b = row(null, CHROME_WIN, 2);
    expect(ids(groupSessionsByDevice([a, b]))).toEqual([[b.id, a.id]]);
  });

  it('does not guess when several devices share the User-Agent', () => {
    const a = row('dev1', CHROME_WIN, 1);
    const b = row('dev2', CHROME_WIN, 2);
    const c = row(null, CHROME_WIN, 3);
    expect(groupSessionsByDevice([a, b, c])).toHaveLength(3);
  });

  it('groups sessions with no deviceId by exact User-Agent', () => {
    const a = row(null, CHROME_WIN, 1);
    const b = row(null, CHROME_WIN, 2);
    const c = row(null, SAFARI_IOS, 3);
    expect(ids(groupSessionsByDevice([a, b, c]))).toEqual([[c.id], [b.id, a.id]]);
  });
});
