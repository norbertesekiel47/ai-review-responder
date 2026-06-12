import { getCacheRedis } from '@/lib/db/redis-cache';
import { reportCaughtError } from './report-caught-error';

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

export interface CheckRateLimitOptions {
  /**
   * When true, Redis errors propagate to the caller instead of being swallowed.
   * Use for cost-sensitive automated jobs (e.g. SerpAPI ranking) where allowing
   * the request on Redis failure would bypass the budget cap.
   * Default: false (fail-open — suitable for user-facing defense-in-depth).
   */
  strict?: boolean;
}

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
  options?: CheckRateLimitOptions,
): Promise<RateLimitResult> {
  const strict = options?.strict ?? false;

  // If Redis is not configured (e.g. Vercel without REDIS_CACHE_URL),
  // allow the request rather than crashing in fail-open mode.
  // In strict mode, throw so the caller can handle the missing budget enforcer.
  if (!process.env.REDIS_CACHE_URL) {
    if (strict) {
      throw new Error('[rate-limit] REDIS_CACHE_URL not configured — cannot enforce budget in strict mode');
    }
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
    if (strict) {
      throw err; // Let caller decide how to handle Redis failure
    }
    // Redis connection failure — allow the request rather than blocking the
    // user, but surface the fail-open to Sentry so an Upstash outage is
    // visible instead of silently disabling rate limiting (deep-scan §8.3).
    // Only the limiter name is reported — the full key can embed a client IP.
    reportCaughtError('shared/rate-limit', err, {
      fail_open: true,
      limiter: key.split(':')[0],
    });
    return { allowed: true, remaining: maxRequests };
  }
}
