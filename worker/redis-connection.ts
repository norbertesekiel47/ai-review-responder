import type { RedisOptions } from 'ioredis';

// ---------------------------------------------------------------------------
// BullMQ Redis connection options.
//
// Side-effect-free (like `queue-names.ts`): importing this module must NOT
// instantiate Queues or open connections, so the logic stays unit-testable
// without booting `worker/queues.ts`.
//
// Supports:
//   redis://localhost:6379/1                          — local Docker / WSL Redis
//   redis://default:pw@redis.railway.internal:6379/1?family=0
//                                                     — Railway, private networking
//   rediss://default:pw@host:6379                      — TLS-enabled Redis (Upstash)
//   https://host.upstash.io                            — Upstash REST URL (+ token)
// ---------------------------------------------------------------------------

/**
 * Parse an ioredis `family` hint from a Redis URL's `?family=` query param.
 *
 * Railway's private network is IPv6-only, and ioredis/BullMQ will not resolve
 * `*.railway.internal` unless `family: 0` is set (per Railway's
 * library-configuration docs). Carrying the hint on the URL keeps this code
 * vendor-neutral — local and Upstash URLs simply omit the param and inherit the
 * ioredis default. Returns 0, 4, or 6 when valid, otherwise undefined.
 */
export function parseRedisFamily(raw: string | null): number | undefined {
  // Match the three literal values exactly — `Number()` coercion would wrongly
  // accept '' (→0), ' 4 ', '4.0', '0x4', etc.
  switch (raw) {
    case '0':
      return 0;
    case '4':
      return 4;
    case '6':
      return 6;
    default:
      return undefined;
  }
}

export function getRedisOptions(): RedisOptions {
  const url = process.env.REDIS_QUEUE_URL!;
  const token = process.env.REDIS_QUEUE_TOKEN;

  // Upstash REST URL → extract host and use Redis protocol over TLS
  if (url.startsWith('https://')) {
    return {
      host: new URL(url).hostname,
      port: 6379,
      password: token,
      tls: {},
      maxRetriesPerRequest: null, // Required by BullMQ
    };
  }

  // Standard redis:// or rediss:// URL (local, Railway, or any Redis)
  const parsed = new URL(url);
  const family = parseRedisFamily(parsed.searchParams.get('family'));
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || token || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
    ...(family !== undefined ? { family } : {}),
  };
}
