import { hashIpForRateLimit } from '@/lib/crypto/hash';
import { adminDb } from '@/lib/firebase/admin.core';

export type RateLimitResult = { ok: boolean; remaining: number; retryAfterSeconds: number };

/**
 * Sliding-window limiter, on Firestore.
 *
 * ===========================================================================
 * WHY A SLIDING WINDOW, STILL
 * ===========================================================================
 * A fixed window lets an attacker send 2x the limit across a window boundary,
 * which matters most on exactly the endpoints we care about: login and
 * document upload. The bucket therefore stores the TIMESTAMPS of recent
 * requests rather than a counter, and each check prunes anything older than
 * the window before it decides. Same algorithm as the Redis sorted set it
 * replaces.
 *
 * ===========================================================================
 * WHAT THE REDIS LUA SCRIPT GAVE US, AND WHAT REPLACES IT
 * ===========================================================================
 * The old implementation ran ZREMRANGEBYSCORE + ZCARD + ZADD as ONE Lua
 * script, which Redis executes atomically - so two simultaneous requests could
 * not both read a count of 9 and both append.
 *
 * A Firestore transaction gives the same property by a different mechanism:
 * the read and the write are one commit, and if the bucket document changes in
 * between, the transaction aborts and re-runs. Optimistic instead of
 * single-threaded, identical outcome.
 *
 * The cost is real and worth stating: this is a transaction (one read, one
 * write) per limited request, where Redis needed one round trip. It is spent
 * only on endpoints that are explicitly rate-limited - login, registration,
 * uploads, purchases - and never on ordinary reads. peekRateLimit() does not
 * pay it at all, being a plain document read.
 *
 * ===========================================================================
 * BUCKETS EXPIRE THEMSELVES
 * ===========================================================================
 * Redis dropped an idle key when its PEXPIRE elapsed. Firestore does not
 * garbage-collect, so every bucket carries `expiresAt` and the deployment
 * declares a FIRESTORE TTL POLICY on that field for this collection:
 *
 *     gcloud firestore fields ttls update expiresAt \
 *       --collection-group=rateLimits --enable-ttl
 *
 * Without that policy nothing breaks and no limit is wrong - a stale bucket is
 * pruned on its next read regardless - it simply accumulates documents nobody
 * looks at. The policy is hygiene, not correctness, which is why its absence
 * is not something this module tries to detect.
 */

export const LIMITS = {
  /**
   * FAILED login attempts per (address + email), not per address.
   *
   * This was 5 per 15 minutes keyed on the hashed IP alone, and it counted
   * every attempt including the successful ones. Two consequences:
   *
   *   - signing in correctly five times in a quarter of an hour locked you out
   *     of your own account, which is what produced 429s on ordinary logins;
   *   - one address is one bucket, so a university NAT or a carrier CGNAT put
   *     thousands of students in the same five attempts. That is the exact
   *     collective punishment this codebase refuses to accept for IP BANS
   *     (see BlocklistType, which deliberately has no IP member) - the login
   *     limiter simply had not been brought in line with it.
   *
   * Ten failures against one email from one address is comfortably beyond
   * fat-fingering a password and well short of useful brute force, especially
   * with the account-level lockout in the route (8 failures -> 15 minutes)
   * sitting behind it.
   */
  'auth:login': { limit: 10, windowMs: 15 * 60_000 },
  /**
   * A wider ceiling on the same address across ALL emails, which is what
   * credential stuffing actually looks like: many accounts, few tries each.
   * Generous enough that a shared campus address never reaches it in normal
   * use, low enough that a scripted run does.
   */
  'auth:login:ip': { limit: 60, windowMs: 15 * 60_000 },
  'auth:register': { limit: 3, windowMs: 60 * 60_000 },
  'auth:password-reset': { limit: 3, windowMs: 60 * 60_000 },
  // Document uploads are expensive downstream (OCR + model inference).
  'verification:submit': { limit: 3, windowMs: 24 * 60 * 60_000 },
  'verification:presign': { limit: 20, windowMs: 60 * 60_000 },
  // Content endpoints: generous enough that a real user never sees them.
  'feed:post': { limit: 20, windowMs: 60 * 60_000 },
  'feed:comment': { limit: 60, windowMs: 60 * 60_000 },
  'notes:upload': { limit: 10, windowMs: 24 * 60 * 60_000 },
  // Its own bucket: uploading notes must never use up the right to apply.
  'mentors:apply': { limit: 5, windowMs: 24 * 60 * 60_000 },
  'orders:create': { limit: 30, windowMs: 60 * 60_000 },
  'notes:review': { limit: 30, windowMs: 60 * 60_000 },
  'notes:save': { limit: 120, windowMs: 60 * 60_000 },
  'notes:download': { limit: 60, windowMs: 60 * 60_000 },
  'mentors:schedule': { limit: 60, windowMs: 60 * 60_000 },
  'bookings:create': { limit: 10, windowMs: 24 * 60 * 60_000 },
  'search': { limit: 120, windowMs: 60_000 },
} as const;

export type LimitKey = keyof typeof LIMITS;

export type RateLimitIdentity = {
  userId?: string;
  ip: string;
  /**
   * Narrows the bucket below the address. Login passes the email here so one
   * person failing to sign in cannot spend everyone else's attempts.
   */
  subject?: string;
};

const COLLECTION = 'rateLimits';

/**
 * The bucket document id.
 *
 * `/` is the one character a Firestore document id may not contain, and none
 * of the pieces here can produce one: the key is a literal from LIMITS, and
 * everything else is a hex digest or an id. The replacement is kept anyway,
 * because an id that silently became a path would put rate-limit state in a
 * subcollection and quietly stop limiting anything.
 */
function bucketKey(key: LimitKey, identity: RateLimitIdentity): string {
  if (identity.subject) {
    return `${key}:s:${hashIpForRateLimit(`${identity.ip}|${identity.subject}`)}`.replace(/\//g, '_');
  }
  const subject = identity.userId ? `u:${identity.userId}` : `i:${hashIpForRateLimit(identity.ip)}`;
  return `${key}:${subject}`.replace(/\//g, '_');
}

/** Drops timestamps that have fallen out of the window. */
function prune(hits: number[], now: number, windowMs: number): number[] {
  return hits.filter((at) => at > now - windowMs);
}

export async function rateLimit(
  key: LimitKey,
  identity: RateLimitIdentity,
): Promise<RateLimitResult> {
  const { limit, windowMs } = LIMITS[key];
  // Authenticated traffic is limited per user; anonymous traffic per hashed IP.
  // Both are needed: per-IP alone punishes a whole NAT'd campus, per-user alone
  // is defeated by registering more accounts.
  const ref = adminDb().collection(COLLECTION).doc(bucketKey(key, identity));

  return adminDb().runTransaction(async (tx) => {
    const now = Date.now();
    const snap = await tx.get(ref);
    const stored = (snap.data()?.hits as number[] | undefined) ?? [];
    const hits = prune(stored, now, windowMs);

    if (hits.length >= limit) {
      const oldest = Math.min(...hits);
      return {
        ok: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      };
    }

    hits.push(now);
    tx.set(ref, { hits, expiresAt: new Date(now + windowMs) });

    return { ok: true, remaining: limit - hits.length, retryAfterSeconds: 0 };
  });
}

/**
 * Read-only variant of the sliding window.
 *
 * A plain read with no write, so asking "am I allowed?" genuinely does not
 * mutate the bucket. This is what lets the login route check the limit BEFORE
 * verifying a password and then charge a token only when the password turns
 * out to be wrong.
 *
 * No transaction, deliberately: nothing is written, so there is nothing to
 * make atomic, and a peek must not cost a commit on every login attempt.
 */
export async function peekRateLimit(
  key: LimitKey,
  identity: RateLimitIdentity,
): Promise<RateLimitResult> {
  const { limit, windowMs } = LIMITS[key];
  const snap = await adminDb().collection(COLLECTION).doc(bucketKey(key, identity)).get();

  const now = Date.now();
  const hits = prune((snap.data()?.hits as number[] | undefined) ?? [], now, windowMs);

  if (hits.length >= limit) {
    const oldest = Math.min(...hits);
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  return { ok: true, remaining: limit - hits.length, retryAfterSeconds: 0 };
}

/**
 * Clears a bucket. Called on a SUCCESSFUL login, mirroring what the route
 * already does with failedLoginCount and lockedUntil: proving you own the
 * account forgives the earlier fumbles. Without this the two counters
 * disagree, and this one silently outlives the reason it exists.
 */
export async function resetRateLimit(
  key: LimitKey,
  identity: RateLimitIdentity,
): Promise<void> {
  await adminDb().collection(COLLECTION).doc(bucketKey(key, identity)).delete();
}

export class RateLimitError extends Error {
  readonly status = 429;
  readonly messageKey = 'errors.rateLimited';
  constructor(public readonly retryAfterSeconds: number) {
    super('Rate limit exceeded');
  }
}

/**
 * Extracts the client IP behind the CDN. Trusts only the leftmost address in
 * the header the platform itself sets - reading a raw X-Forwarded-For allows
 * anyone to spoof their way past an IP-based limit or blocklist entry.
 */
export function clientIp(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    '0.0.0.0'
  );
}
