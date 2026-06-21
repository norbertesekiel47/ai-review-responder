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
