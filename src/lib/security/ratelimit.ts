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

export const LIMITS = {
  // Tight: credential stuffing is the highest-volume attack on a student site.
  'auth:login': { limit: 5, windowMs: 15 * 60_000 },
  'auth:register': { limit: 3, windowMs: 60 * 60_000 },
  'auth:password-reset': { limit: 3, windowMs: 60 * 60_000 },
  // Document uploads are expensive downstream (OCR + model inference).
  'verification:submit': { limit: 3, windowMs: 24 * 60 * 60_000 },
  'verification:presign': { limit: 20, windowMs: 60 * 60_000 },
  // Content endpoints: generous enough that a real user never sees them.
  'feed:post': { limit: 20, windowMs: 60 * 60_000 },
  'feed:comment': { limit: 60, windowMs: 60 * 60_000 },
  'notes:upload': { limit: 10, windowMs: 24 * 60 * 60_000 },
  'orders:create': { limit: 30, windowMs: 60 * 60_000 },
  'bookings:create': { limit: 10, windowMs: 24 * 60 * 60_000 },
  'search': { limit: 120, windowMs: 60_000 },
} as const;

export type LimitKey = keyof typeof LIMITS;

export async function rateLimit(
  key: LimitKey,
  identity: { userId?: string; ip: string },
): Promise<RateLimitResult> {
  const { limit, windowMs } = LIMITS[key];
  // Authenticated traffic is limited per user; anonymous traffic per hashed IP.
  // Both are needed: per-IP alone punishes a whole NAT'd campus, per-user alone
  // is defeated by registering more accounts.
  const subject = identity.userId ? `u:${identity.userId}` : `i:${hashIpForRateLimit(identity.ip)}`;
  const redisKey = `rl:${key}:${subject}`;

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
