/**
 * Folds an account's sessions into one row per DEVICE for Settings → Devices.
 *
 * Signing in again from a browser that still holds an older, unexpired
 * session (cookies cleared, a second tab signing in, a QR link on the same
 * machine) leaves two live rows that look identical: "Chrome · Windows" twice.
 * They are the same device, so they are shown - and signed out - as one.
 *
 * The key is the recorded device (`deviceId`, from the sign-in fingerprint)
 * and, for sessions without one, the exact User-Agent string. The readable
 * label ("Chrome · Windows") is deliberately NOT the key: two different
 * laptops share it, and merging them would sign out a machine the owner did
 * not pick. A session without a deviceId whose User-Agent matches exactly one
 * recorded device is folded into that device; when several recorded devices
 * share the string, which one it belongs to is unknowable, so it stays its
 * own row rather than being guessed.
 */

export type GroupableSession = {
  id: string;
  deviceId: string | null;
  userAgent: string;
  authAt: Date;
  lastSeenAt: Date;
};

export type SessionGroup<T extends GroupableSession> = {
  key: string;
  /** Newest activity first. */
  sessions: T[];
};

export function groupSessionsByDevice<T extends GroupableSession>(rows: T[]): SessionGroup<T>[] {
  const devicesByAgent = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.deviceId) continue;
    const seen = devicesByAgent.get(row.userAgent) ?? new Set<string>();
    seen.add(row.deviceId);
    devicesByAgent.set(row.userAgent, seen);
  }

  const keyOf = (row: T): string => {
    if (row.deviceId) return `device:${row.deviceId}`;
    const candidates = devicesByAgent.get(row.userAgent);
    if (candidates?.size === 1) return `device:${[...candidates][0]}`;
    return `agent:${row.userAgent}`;
  };

  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.entries()]
    .map(([key, sessions]) => ({
      key,
      sessions: sessions.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()),
    }))
    .sort((a, b) => b.sessions[0].lastSeenAt.getTime() - a.sessions[0].lastSeenAt.getTime());
}
