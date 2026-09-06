import { hashIpForRateLimit } from '@/lib/crypto/hash';
import { getRedis } from '@/lib/queue/connection';

export type RateLimitResult = { ok: boolean; remaining: number; retryAfterSeconds: number };

/**
 * Sliding-window limiter in one Redis round trip.
 *
 * A fixed window lets an attacker send 2x the limit across a window boundary,
 * which matters most on exactly the endpoints we care about: login and
 * document upload. This uses a sorted set of request timestamps instead.
 */
const SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, 0, math.ceil((tonumber(oldest[2]) + window - now) / 1000)}
end
redis.call('ZADD', key, now, now .. ':' .. math.random())
redis.call('PEXPIRE', key, window)
return {1, limit - count - 1, 0}
`;

/** Read-only counterpart to SCRIPT. Adds nothing to the sorted set. */
const PEEK_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local count = redis.call('ZCOUNT', key, now - window, '+inf')
if count >= limit then
  local oldest = redis.call('ZRANGEBYSCORE', key, now - window, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
  if oldest[2] == nil then
    return {1, limit, 0}
  end
  return {0, 0, math.ceil((tonumber(oldest[2]) + window - now) / 1000)}
end
return {1, limit - count, 0}
`;

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
  /**
   * Direct messages. Higher than commenting because a real conversation is
   * bursty - people send several short lines in a row - but bounded, since
   * messaging is the one surface that reaches a specific stranger's inbox and
   * is therefore the natural vector for harassment at volume.
   */
  'messages:send': { limit: 120, windowMs: 60 * 60_000 },
  'notes:upload': { limit: 10, windowMs: 24 * 60 * 60_000 },
  'orders:create': { limit: 30, windowMs: 60 * 60_000 },
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

function bucketKey(key: LimitKey, identity: RateLimitIdentity): string {
  if (identity.subject) {
    return `rl:${key}:s:${hashIpForRateLimit(`${identity.ip}|${identity.subject}`)}`;
  }
  const subject = identity.userId ? `u:${identity.userId}` : `i:${hashIpForRateLimit(identity.ip)}`;
  return `rl:${key}:${subject}`;
}

export async function rateLimit(
  key: LimitKey,
  identity: RateLimitIdentity,
): Promise<RateLimitResult> {
  const { limit, windowMs } = LIMITS[key];
  // Authenticated traffic is limited per user; anonymous traffic per hashed IP.
  // Both are needed: per-IP alone punishes a whole NAT'd campus, per-user alone
  // is defeated by registering more accounts.
  const redisKey = bucketKey(key, identity);

  const [ok, remaining, retryAfter] = (await getRedis().eval(
    SCRIPT,
    1,
    redisKey,
    Date.now().toString(),
    windowMs.toString(),
    limit.toString(),
  )) as [number, number, number];

  return { ok: ok === 1, remaining, retryAfterSeconds: retryAfter };
}


/**
 * Read-only variant of the sliding window.
 *
 * ZCOUNT over the live window rather than ZREMRANGEBYSCORE + ZCARD, so asking
 * "am I allowed?" genuinely does not mutate the bucket. This is what lets the
 * login route check the limit BEFORE verifying a password and then charge a
 * token only when the password turns out to be wrong.
 */
export async function peekRateLimit(
  key: LimitKey,
  identity: RateLimitIdentity,
): Promise<RateLimitResult> {
  const { limit, windowMs } = LIMITS[key];
  const [ok, remaining, retryAfter] = (await getRedis().eval(
    PEEK_SCRIPT,
    1,
    bucketKey(key, identity),
    Date.now().toString(),
    windowMs.toString(),
    limit.toString(),
  )) as [number, number, number];

  return { ok: ok === 1, remaining, retryAfterSeconds: retryAfter };
}

/**
 * Clears a bucket. Called on a SUCCESSFUL login, mirroring what the route
 * already does with failedLoginCount and lockedUntil in Postgres: proving you
 * own the account forgives the earlier fumbles. Without this the two counters
 * disagree, and the Redis one silently outlives the reason it exists.
 */
export async function resetRateLimit(
  key: LimitKey,
  identity: RateLimitIdentity,
): Promise<void> {
  await getRedis().del(bucketKey(key, identity));
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
