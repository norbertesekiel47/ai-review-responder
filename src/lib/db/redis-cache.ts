import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

// ── Redis client (cache instance, NOT queue) ─────────────────────────
// Supports: redis://localhost:6379/0, rediss://host:6379, https://host.upstash.io

export function getCacheRedisOptions(): RedisOptions {
  const url = process.env.REDIS_CACHE_URL!;
  const token = process.env.REDIS_CACHE_TOKEN;

  // Shared options: fail fast so rate limiter catch blocks fire instead of
  // hanging indefinitely when Redis is unreachable (e.g. local dev without Docker).
  //
  // `enableOfflineQueue: true` (default) lets the client buffer commands
  // briefly while ioredis completes its async handshake. Without it, the
  // first request after a fresh dev-server boot races the TCP connect and
  // fails with "Stream isn't writeable" — causing a spurious 503 on every
  // first prefill. Fail-fast on TRULY-dead Redis is still guaranteed by
  // `connectTimeout: 3_000` plus the retry strategy returning null after
  // two attempts (~600ms), which transitions the client to "end" state so
  // queued commands fail with "Connection is closed" within ~1s.
  const sharedOpts: Partial<RedisOptions> = {
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    // Bound each command, not just the connect: a slow-but-CONNECTED Upstash
    // (latency spike under load) sits on the pre-LLM hot path (idempotency check,
    // cost reserve, concurrency slot). Without this, a degraded-but-up Upstash
    // hangs each command up to the LLM's 30s budget instead of failing fast into
    // the existing retryable (CostInfraUnavailableError) / fail-open (rate-limit)
    // paths. 3s is ~60× normal Upstash latency, so it never trips in steady state.
    commandTimeout: 3_000,
    retryStrategy: (times) => (times > 2 ? null : Math.min(times * 200, 1_000)),
  };

  // Upstash REST URL → extract host and use Redis protocol over TLS
  if (url.startsWith('https://')) {
    return {
      ...sharedOpts,
      host: new URL(url).hostname,
      port: 6379,
      password: token,
      tls: {},
    };
  }

  // Standard redis:// or rediss:// URL (local, Railway, or any Redis)
  const parsed = new URL(url);
  return {
    ...sharedOpts,
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || token || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
  };
}

let _redis: Redis | null = null;

export function getCacheRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(getCacheRedisOptions());
  }
  return _redis;
}

// ── Stampede guard for withTtlCache ──────────────────────────────────
//
// N concurrent misses on ONE key used to run N full computes (for the
// dashboard payload that is ~15 serial statements each, on a 3-connection
// pool — the Capacity target's "10 concurrent dashboard renders" is exactly
// this shape). The first miss now takes a short NX lock; the others poll the
// cache key briefly and return the value the lock holder wrote. Every Redis
// step stays fail-open: a lock error, a poll error, or a poll that never sees
// the value all fall through to a fresh compute, exactly as before.
const CACHE_LOCK_TTL_MS = 5_000;
/** How many times a non-holder re-reads the cache key before computing. */
export const CACHE_LOCK_POLL_ATTEMPTS = 5;
export const CACHE_LOCK_POLL_INTERVAL_MS = 200;

// Compare-and-delete: only the token that took the lock may release it, so a
// holder whose compute outlived CACHE_LOCK_TTL_MS cannot delete the lock a
// later caller acquired.
const RELEASE_LOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

type LockOutcome = 'acquired' | 'held_elsewhere' | 'unavailable';

async function tryAcquireLock(
  redis: Redis,
  lockKey: string,
  token: string,
  source: string,
): Promise<LockOutcome> {
  try {
    const reply = await redis.set(lockKey, token, 'PX', CACHE_LOCK_TTL_MS, 'NX');
    return reply === 'OK' ? 'acquired' : 'held_elsewhere';
  } catch (error) {
    console.error(`[${source}] cache lock failed (computing fresh):`, error);
    return 'unavailable';
  }
}

async function releaseLock(redis: Redis, lockKey: string, token: string, source: string): Promise<void> {
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
  } catch (error) {
    // The lock expires on its own after CACHE_LOCK_TTL_MS; a failed release
    // only delays the next miss's lock by that much.
    console.error(`[${source}] cache lock release failed (lock expires on its own):`, error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Non-holder path: wait briefly for the holder's write. `null` = give up. */
async function pollForCachedValue(
  redis: Redis,
  key: string,
  source: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < CACHE_LOCK_POLL_ATTEMPTS; attempt++) {
    await sleep(CACHE_LOCK_POLL_INTERVAL_MS);
    try {
      const cached = await redis.get(key);
      if (cached) return cached;
    } catch (error) {
      console.error(`[${source}] cache poll failed (computing fresh):`, error);
      return null;
    }
  }
  return null;
}

/**
 * Read-through JSON cache with fail-open Redis reads and writes. `compute`
 * runs outside those catch blocks: rejected computations (including
 * BusinessNotFoundError) propagate and are never cached. Resolved values are
 * cacheable as-is, including intentionally degraded aggregate payloads.
 *
 * Concurrent misses on one key are coalesced by a short NX lock (see the
 * stampede-guard block above): the holder computes and writes, the rest poll
 * the key for up to CACHE_LOCK_POLL_ATTEMPTS × CACHE_LOCK_POLL_INTERVAL_MS
 * and compute themselves only if the value never appears.
 */
export async function withTtlCache<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
  source: string,
): Promise<T> {
  const redis = getCacheRedis();
  // Once a Redis step has failed, skip the optional lock steps: on a
  // slow-but-connected Redis each command can wait the full commandTimeout,
  // and the guard must never make a degraded miss slower than it was before
  // the guard existed (read + write, two commands).
  let redisHealthy = true;
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as T;
  } catch (error) {
    redisHealthy = false;
    console.error(`[${source}] cache read failed (computing fresh):`, error);
  }

  const lockKey = `${key}:lock`;
  const token = randomUUID();
  const lock = redisHealthy ? await tryAcquireLock(redis, lockKey, token, source) : 'unavailable';
  if (lock === 'held_elsewhere') {
    const cached = await pollForCachedValue(redis, key, source);
    if (cached) return JSON.parse(cached) as T;
  }
  const holdsLock = lock === 'acquired';

  let value: T;
  try {
    value = await compute();
  } catch (error) {
    if (holdsLock) await releaseLock(redis, lockKey, token, source);
    throw error;
  }

  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (error) {
    redisHealthy = false;
    console.error(`[${source}] cache write failed (serving fresh):`, error);
  }
  if (holdsLock && redisHealthy) await releaseLock(redis, lockKey, token, source);

  return value;
}
