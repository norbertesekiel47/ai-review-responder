import { getCacheRedis } from '@/lib/db/redis-cache';
import { ZernioRouteError } from '@/lib/zernio/errors';
import {
  finalizeLockKey,
  generateLockToken,
  luaTokenCAS,
} from '@/lib/zernio/connect-state';

type CacheRedis = ReturnType<typeof getCacheRedis>;

// Spec §3.2 step 3: lock TTL widened from 30s → 60s to comfortably cover
// the Zernio call (15s budget) + DB tx + 3 Redis ops + cookie set, even
// on a slow network.
const FINALIZE_LOCK_TTL_SECONDS = 60;

/**
 * Acquires the per-session finalize lock (NX, 60s TTL), runs `fn`, then
 * releases the lock with a token-stamped CAS so a parallel finalize's lock is
 * never released. A held lock throws `ZernioRouteError(409,
 * 'finalize_in_progress')`. If the NX acquire itself throws, the error
 * propagates and the release is NOT attempted (the lock was never ours).
 */
export async function withFinalizeLock<T>(
  redis: CacheRedis,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // 7. Acquire finalize lock — the FULL finalize sequence happens inside it
  // (round-7 correction). 60s TTL covers Zernio call + DB tx + 3 Redis ops
  // + cookie set; explicit release in finally on every path.
  const finalizeKey = finalizeLockKey(sessionId);
  const finalizeToken = generateLockToken();
  const acquired = await redis.set(
    finalizeKey,
    finalizeToken,
    'EX',
    FINALIZE_LOCK_TTL_SECONDS,
    'NX',
  );
  if (!acquired) {
    throw new ZernioRouteError(409, 'finalize_in_progress');
  }

  try {
    return await fn();
  } finally {
    // 9. Release the finalize lock — token-stamped CAS so we never
    // accidentally release a lock acquired by a parallel finalize.
    await redis.eval(luaTokenCAS, 1, finalizeKey, finalizeToken).catch(() => {
      // Best-effort: 60s TTL is the safety net.
    });
  }
}
