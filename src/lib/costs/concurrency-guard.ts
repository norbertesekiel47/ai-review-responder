import { getCacheRedis } from '@/lib/db/redis-cache';
import { CostInfraUnavailableError } from './errors';

/**
 * Per-business generation concurrency semaphore, backed by a Redis counter
 * with a TTL safety net. Acquire/release are paired by the caller; the TTL
 * guarantees a slot is reclaimed even if a release is lost to a crash.
 */

export class ConcurrencyLimitExceededError extends Error {
  constructor(public readonly businessId: string) {
    super(`Concurrency limit exceeded for business ${businessId}`);
    this.name = 'ConcurrencyLimitExceededError';
  }
}

const MAX_CONCURRENCY_PER_BUSINESS = 3;
const CONCURRENCY_TTL_SECONDS = 300; // 5-minute safety net

function concurrencyKey(businessId: string): string {
  return `gen:active:${businessId}`;
}

// INCR + limit check + TTL + rollback collapsed into one atomic Lua script so a
// mid-sequence crash cannot leave a concurrency-slot key without its TTL.
const ACQUIRE_CONCURRENCY_LUA = `
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local cur = redis.call('INCR', KEYS[1])
if cur > limit then
  redis.call('DECR', KEYS[1])
  return {'exceeded', cur}
end
redis.call('EXPIRE', KEYS[1], ttl)
return {'ok', cur}
`;

export async function acquireConcurrencySlot(
  businessId: string,
): Promise<void> {
  const redis = getCacheRedis();
  const key = concurrencyKey(businessId);

  // Only the Redis round-trip is wrapped — a transport failure becomes a
  // retryable infra error. A 'exceeded' result is a slot-full business case
  // (already retryable downstream) and stays a ConcurrencyLimitExceededError.
  let raw: [string, number];
  try {
    raw = (await redis.eval(
      ACQUIRE_CONCURRENCY_LUA,
      1,
      key,
      String(MAX_CONCURRENCY_PER_BUSINESS),
      String(CONCURRENCY_TTL_SECONDS),
    )) as [string, number];
  } catch (err) {
    throw new CostInfraUnavailableError('acquireConcurrencySlot', { cause: err });
  }

  if (raw[0] === 'exceeded') {
    throw new ConcurrencyLimitExceededError(businessId);
  }
}

export async function releaseConcurrencySlot(
  businessId: string,
): Promise<void> {
  const redis = getCacheRedis();
  const result = await redis.decr(concurrencyKey(businessId));
  if (result < 0) {
    await redis.set(concurrencyKey(businessId), '0');
  }
}
