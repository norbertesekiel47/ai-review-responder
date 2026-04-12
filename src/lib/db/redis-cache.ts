import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

// ── Redis client (cache instance, NOT queue) ─────────────────────────
// Supports: redis://localhost:6379/0, rediss://host:6379, https://host.upstash.io

export function getCacheRedisOptions(): RedisOptions {
  const url = process.env.REDIS_CACHE_URL!;
  const token = process.env.REDIS_CACHE_TOKEN;

  // Upstash REST URL → extract host and use Redis protocol over TLS
  if (url.startsWith('https://')) {
    return {
      host: new URL(url).hostname,
      port: 6379,
      password: token,
      tls: {},
      maxRetriesPerRequest: null,
    };
  }

  // Standard redis:// or rediss:// URL (local, Railway, or any Redis)
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || token || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

let _redis: Redis | null = null;

export function getCacheRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(getCacheRedisOptions());
  }
  return _redis;
}
