import { getCacheRedis } from '@/lib/costs/tracker';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

/**
 * Fixed-window rate limiter using a Lua script for atomic INCR + EXPIRE
 * on the cache Redis instance (NOT the queue instance).
 *
 * A plain INCR → EXPIRE sequence is not failure-safe: if the process
 * crashes between the two calls the key is left without a TTL and the
 * caller stays rate-limited forever. The Lua script runs both operations
 * in a single Redis round-trip, eliminating that gap.
 */
const RATE_LIMIT_LUA = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return current
`;

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const redis = getCacheRedis();
  const current = await redis.eval(
    RATE_LIMIT_LUA,
    1,
    key,
    String(windowSeconds),
  ) as number;

  if (current > maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: maxRequests - current };
}
