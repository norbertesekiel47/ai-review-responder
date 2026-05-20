import { getCacheRedis } from '@/lib/db/redis-cache';
import { zernioClient } from '@/lib/zernio/client';
import {
  pendingKey,
  stateKey,
  profileStateKey,
  luaDeletePendingByFlowIdAnyStatus,
} from '@/lib/zernio/connect-state';
import type { ConnectStateBlob, ConnectPendingMarker } from '@/lib/zernio/types';

/**
 * OAuth-denial cleanup (callback spec §3.2 step 2).
 *
 * Owner denied OAuth on Google's side (or Zernio surfaced an explicit error).
 * Best-effort cleanup BEFORE redirecting:
 *   1. Atomically claim connect_state (so it can't be reused).
 *   2. Verify connect_pending still belongs to this flow, then CAS-delete it
 *      via luaDeletePendingByFlowIdAnyStatus so the user isn't blocked from
 *      starting a new flow for up to 15 min.
 *   3. Best-effort deleteProfile so the orphaned Zernio profile is freed.
 *
 * Every step is wrapped in catch() — failures don't block the user-facing
 * redirect. This function never throws.
 */
export async function cleanupAfterOauthDenial(stateParam: string): Promise<void> {
  const redisCleanup = getCacheRedis();
  try {
    const stateRaw = await redisCleanup.getdel(stateKey(stateParam)).catch(() => null);
    if (stateRaw) {
      let stored: ConnectStateBlob | null = null;
      try {
        stored = JSON.parse(stateRaw) as ConnectStateBlob;
      } catch {
        // malformed state blob — already claimed, nothing more to do
      }
      if (stored) {
        try {
          const pendingRaw = await redisCleanup
            .get(pendingKey(stored.businessId))
            .catch(() => null);
          if (pendingRaw) {
            try {
              const pending = JSON.parse(pendingRaw) as ConnectPendingMarker;
              if (
                pending.state === stateParam &&
                pending.profileId === stored.profileId
              ) {
                await redisCleanup
                  .eval(
                    luaDeletePendingByFlowIdAnyStatus,
                    1,
                    pendingKey(stored.businessId),
                    pending.flowId,
                  )
                  .catch(() => 0);
              }
            } catch {
              // malformed pending — leave it (TTL will handle it)
            }
          }
        } catch (e) {
          console.error(
            '[zernio/callback] OAuth-denial pending cleanup failed:',
            e,
          );
        }
        await zernioClient.deleteProfile(stored.profileId).catch((e) => {
          console.error(
            '[zernio/callback] OAuth-denial deleteProfile failed:',
            e,
          );
        });
        await redisCleanup.del(profileStateKey(stored.profileId)).catch(() => {
          // Best-effort.
        });
      }
    }
  } catch (e) {
    console.error('[zernio/callback] OAuth-denial cleanup failed:', e);
  }
}
