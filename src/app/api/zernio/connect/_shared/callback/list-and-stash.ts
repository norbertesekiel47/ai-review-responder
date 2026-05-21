import { getCacheRedis } from '@/lib/db/redis-cache';
import { zernioClient } from '@/lib/zernio/client';
import { pendingKey, locationsKey, generateSessionId } from '@/lib/zernio/connect-state';
import type {
  ConnectStateBlob,
  ConnectPendingMarker,
  ConnectLocationsBlob,
} from '@/lib/zernio/types';

const LOCATIONS_TTL_SECONDS = 900; // 15 min — matches signed-cookie Max-Age

/**
 * Lua compare-and-delete used in callback failure cleanup.
 *
 * Round-13 (spec §3.2 step 2): a stale OAuth callback from a flow that has
 * been "cancel & restart"-superseded must NOT delete the NEWER pending
 * marker. The DEL fires only if the stored value still byte-matches the
 * value we read. If a parallel flow overwrote it between GET and DEL, the
 * comparison fails and we leave it alone.
 */
const luaCASDelByValue = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end`;

export type ListAndStashResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      kind: 'controlled';
      code:
        | 'flow_cancelled_during_listing'
        | 'malformed_pending'
        | 'flow_superseded_during_listing';
      cleanupProfileId: string;
    }
  | { ok: false; kind: 'thrown'; code: 'zernio_listlocations_failed' };

/**
 * Callback step 6 (spec §3.2 step 2): Zernio listLocations, the round-11
 * second pending re-check, and the connect_locations stash.
 *
 * TWO DISTINCT failure surfaces — DO NOT merge:
 *   - CONTROLLED: post-network re-verify failures (flow_cancelled_during_listing,
 *     malformed_pending, flow_superseded_during_listing). These return a
 *     `controlled` result with `cleanupProfileId`; the CALLER runs
 *     cleanupOrphanedProfileBestEffort. No cleanup happens in this module.
 *   - THROWN: an actual thrown listLocations failure hits the catch branch,
 *     which runs the value-equal luaCASDelByValue pending cleanup + deleteProfile
 *     IN-MODULE, then returns `thrown`/zernio_listlocations_failed.
 *
 * On success, returns the freshly generated sessionId; the caller builds the
 * 302 + signed cookie. This module never builds the NextResponse.
 */
export async function listLocationsAndStash(args: {
  stored: ConnectStateBlob;
  pending: ConnectPendingMarker;
  state: string;
  pendingDataToken: string;
  apiConnectToken: string | undefined;
}): Promise<ListAndStashResult> {
  const { stored, pending, state, pendingDataToken, apiConnectToken } = args;
  const redis = getCacheRedis();

  try {
    const { locations } = await zernioClient.listLocations({
      profileId: stored.profileId,
      pendingDataToken,
      connectToken: apiConnectToken,
    });

    // Round-11: re-verify pending marker AFTER the network round-trip.
    // listLocations can take seconds; a parallel cancel/restart could have
    // overwritten connect_pending in the meantime. If that happened, do NOT
    // write connect_locations and do NOT set the cookie — the newer flow
    // owns the slot now.
    const pending2Raw = await redis.get(pendingKey(stored.businessId));
    if (!pending2Raw) {
      return {
        ok: false,
        kind: 'controlled',
        code: 'flow_cancelled_during_listing',
        cleanupProfileId: stored.profileId,
      };
    }
    let pending2: ConnectPendingMarker;
    try {
      pending2 = JSON.parse(pending2Raw) as ConnectPendingMarker;
    } catch {
      return {
        ok: false,
        kind: 'controlled',
        code: 'malformed_pending',
        cleanupProfileId: stored.profileId,
      };
    }
    if (
      pending2.flowId !== pending.flowId ||
      pending2.state !== state ||
      pending2.profileId !== stored.profileId ||
      pending2.status !== 'oauth_in_progress'
    ) {
      return {
        ok: false,
        kind: 'controlled',
        code: 'flow_superseded_during_listing',
        cleanupProfileId: stored.profileId,
      };
    }

    // 7. Stash for the picker. Includes flowId + state + userId + businessId
    // so /select-location can verify cross-route flow identity (spec §3.2
    // step 3 round-10) and per-user/per-business scope.
    const sessionId = generateSessionId();
    const blob: ConnectLocationsBlob = {
      flowId: pending2.flowId,
      state,
      connect_token: apiConnectToken ?? pendingDataToken,
      pending_data_token: pendingDataToken,
      profileId: stored.profileId,
      businessId: stored.businessId,
      userId: stored.userId,
      locations,
    };
    await redis.setex(
      locationsKey(sessionId),
      LOCATIONS_TTL_SECONDS,
      JSON.stringify(blob),
    );

    return { ok: true, sessionId };
  } catch (cbErr) {
    // Round-13 callback failure cleanup. connect_state is already gone via
    // GETDEL above so replay is blocked regardless of what we do here.
    //
    // For connect_pending: only delete if it's STILL byte-equal to the value
    // we already validated. A parallel flow could have overwritten it during
    // the failed listLocations call; deleting that newer marker would orphan
    // the second flow.
    try {
      const currentPending = await redis
        .get(pendingKey(stored.businessId))
        .catch(() => null);
      if (currentPending) {
        let shouldDelete = false;
        try {
          const p = JSON.parse(currentPending) as ConnectPendingMarker;
          if (p.state === state && p.profileId === stored.profileId) {
            shouldDelete = true;
          }
        } catch {
          // Malformed JSON — leave the marker, it will auto-expire on TTL.
        }
        if (shouldDelete) {
          await redis
            .eval(luaCASDelByValue, 1, pendingKey(stored.businessId), currentPending)
            .catch(() => {
              // Best-effort: parallel writer raced, marker auto-expires.
            });
        }
      }

      // Best-effort Zernio Profile cleanup. The profile was created for THIS
      // flow in /start, so it's always safe to delete on our path failure.
      if (stored.profileId) {
        await zernioClient.deleteProfile(stored.profileId).catch(() => {
          // Best-effort orphan cleanup.
        });
      }
    } catch (cleanupErr) {
      console.error(
        '[api/zernio/connect/callback] cleanup failed (non-fatal):',
        cleanupErr,
      );
    }

    console.error('[api/zernio/connect/callback] listLocations failed:', cbErr);
    return { ok: false, kind: 'thrown', code: 'zernio_listlocations_failed' };
  }
}
