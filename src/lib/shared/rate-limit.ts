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
  // If Redis is not configured (e.g. Vercel without REDIS_CACHE_URL),
  // allow the request rather than crashing. Rate limiting is defense-in-depth,
  // not a hard gate — the approval service has its own idempotency guards.
  if (!process.env.REDIS_CACHE_URL) {
    return { allowed: true, remaining: maxRequests };
  }

  try {
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
  } catch (err) {
    // Redis connection failure — allow the request rather than blocking the user
    console.error('[rate-limit] Redis unavailable, allowing request:', err instanceof Error ? err.message : err);
    return { allowed: true, remaining: maxRequests };
  }
}
