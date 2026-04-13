import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

// ── Redis client (cache instance, NOT queue) ─────────────────────────
// Supports: redis://localhost:6379/0, rediss://host:6379, https://host.upstash.io

export function getCacheRedisOptions(): RedisOptions {
  const url = process.env.REDIS_CACHE_URL!;
  const token = process.env.REDIS_CACHE_TOKEN;

  // Shared options: fail fast so rate limiter catch blocks fire instead of
  // hanging indefinitely when Redis is unreachable (e.g. local dev without Docker).
  const sharedOpts: Partial<RedisOptions> = {
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    retryStrategy: (times) => (times > 2 ? null : Math.min(times * 200, 1_000)),
    enableOfflineQueue: false,
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
