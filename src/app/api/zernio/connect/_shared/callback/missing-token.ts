import { getCacheRedis } from '@/lib/db/redis-cache';
import { zernioClient } from '@/lib/zernio/client';
import {
  pendingKey,
  stateKey,
  profileStateKey,
  luaDeletePendingByFlowIdAnyStatus,
} from '@/lib/zernio/connect-state';
import type {
  ConnectStateBlob,
  ConnectPendingMarker,
} from '@/lib/zernio/types';

/**
 * Missing-token cleanup (callback spec §3.2 step 2).
 *
 * The callback arrived with a usable `state` but no connect/pending-data
 * token — there is nothing we can exchange with Zernio, so the flow is dead.
 * Best-effort cleanup BEFORE redirecting to `?error=missing_params`:
 *   1. Atomically claim connect_state (so it can't be reused).
 *   2. Drop the profile→state reverse index (it auto-expires anyway).
 *   3. Verify connect_pending still belongs to this flow, then CAS-delete it
 *      via luaDeletePendingByFlowIdAnyStatus so the owner isn't blocked from
 *      starting a new flow for up to 15 min.
 *   4. Best-effort deleteProfile so the orphaned Zernio profile is freed.
 *
 * Every step is individually wrapped in catch() — failures don't block the
 * user-facing redirect. This function never throws.
 *
 * Sibling of `cleanupAfterOauthDenial` (./oauth-denial); same claim→gate→
 * CAS-delete→deleteProfile shape, different trigger condition.
 */
export async function cleanupMissingTokenState(state: string): Promise<void> {
  const redis = getCacheRedis();
  const stateRaw = await redis.getdel(stateKey(state)).catch((err) => {
    console.warn(
      `[zernio.callback] missing token cleanup: state GETDEL failed state=${state} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  });
  if (!stateRaw) {
    console.warn(`[zernio.callback] missing token cleanup: no state blob state=${state}`);
    return;
  }

  let stored: ConnectStateBlob;
  try {
    stored = JSON.parse(stateRaw) as ConnectStateBlob;
  } catch {
    console.warn(`[zernio.callback] missing token cleanup: malformed state blob state=${state}`);
    return;
  }
  await redis.del(profileStateKey(stored.profileId)).catch(() => {
    // Best-effort: profile lookup auto-expires.
  });

  const pendingRaw = await redis.get(pendingKey(stored.businessId)).catch((err) => {
    console.warn(
      `[zernio.callback] missing token cleanup: pending GET failed business=${stored.businessId} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  });
  if (pendingRaw) {
    try {
      const pending = JSON.parse(pendingRaw) as ConnectPendingMarker;
      if (pending.state === state && pending.profileId === stored.profileId) {
        await redis
          .eval(
            luaDeletePendingByFlowIdAnyStatus,
            1,
            pendingKey(stored.businessId),
            pending.flowId,
          )
          .catch((err) => {
            console.warn(
              `[zernio.callback] missing token cleanup: pending delete failed business=${stored.businessId} err=${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }
    } catch {
      console.warn(
        `[zernio.callback] missing token cleanup: malformed pending business=${stored.businessId}`,
      );
    }
  }

  await zernioClient.deleteProfile(stored.profileId).catch((err) => {
    console.warn(
      `[zernio.callback] missing token cleanup: deleteProfile failed profile=${stored.profileId} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}
