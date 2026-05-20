import { NextRequest, NextResponse } from 'next/server';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { zernioClient } from '@/lib/zernio/client';
import {
  pendingKey,
  stateKey,
  profileStateKey,
  locationsKey,
  generateSessionId,
  luaDeletePendingByFlowIdAnyStatus,
} from '@/lib/zernio/connect-state';
import { setConnectSessionCookie } from '@/lib/zernio/connect-session-cookie';
import type {
  ConnectStateBlob,
  ConnectPendingMarker,
  ConnectLocationsBlob,
} from '@/lib/zernio/types';
import { cleanupAfterOauthDenial } from '../_shared/callback/oauth-denial';
import { claimAndVerifyConnectState } from '../_shared/callback/claim-and-verify';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;
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

function connectTokenFromState(state: string | null): string | null {
  if (!state) return null;
  const lastSegment = state.split('-').at(-1);
  return lastSegment?.startsWith('ct_') ? lastSegment : null;
}

async function stateFromProfileId(profileId: string | null): Promise<string | null> {
  if (!profileId) return null;
  return await getCacheRedis()
    .get(profileStateKey(profileId))
    .catch((err) => {
      console.warn(
        `[zernio.callback] profile state lookup failed profile=${profileId} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    });
}

/**
 * Best-effort Zernio profile cleanup for the early-return paths after the
 * state has been atomically claimed. The profile was created for THIS flow
 * in /start, so deleting it on any abandonment is safe (no parallel flow
 * uses the same profileId — every flow generates its own).
 *
 * NOT called from the OAuth-denial branch — that branch has its own,
 * richer cleanup that ALSO byte-CAS-deletes the pending marker if it
 * still belongs to this flow. This helper is for the paths where pending
 * is missing, malformed, or owned by a different (newer) flow — in all
 * those cases we must NOT trample pending, only orphan-clean the profile.
 */
async function cleanupOrphanedProfileBestEffort(
  profileId: string | undefined,
): Promise<void> {
  if (!profileId) return;
  try {
    await zernioClient.deleteProfile(profileId);
  } catch (err) {
    console.error(
      '[api/zernio/connect/callback] orphan profile cleanup failed (non-fatal):',
      err,
    );
  }
}

async function cleanupMissingTokenState(state: string): Promise<void> {
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

/**
 * GET /api/zernio/connect/callback?state=...&connect_token=...
 *
 * OAuth landing endpoint after Zernio redirects the owner back from Google's
 * consent screen. Spec §3.2 step 2.
 *
 * Choreography (paraphrased):
 *   1. Atomic GETDEL of `connect_state:{state}` — single-use claim.
 *   2. Verify pending marker matches (state, profileId, status='oauth_in_progress').
 *   3. Re-auth: current Supabase user must equal stored.userId.
 *   4. Call Zernio listLocations.
 *   5. Round-11 second pending re-check (CRITICAL): listLocations can take
 *      seconds — during which a cancel/restart could overwrite connect_pending.
 *      Without this re-check we'd write connect_locations + set the picker
 *      cookie pointing at a stale flow. Re-read, parse, re-validate.
 *   6. Stash `connect_locations:{sessionId}` (15 min) and set HttpOnly,
 *      HMAC-signed cookie.
 *   7. 302 redirect to /dashboard/connect/select-location.
 *
 * Failure handling: any internal failure becomes a redirect to
 * `/dashboard/connect?error=...`, NOT a JSON response — the user is mid-OAuth
 * round-trip and needs friendly UI, not a 4xx body.
 *
 * Cancellation cleanup (round-13): on listLocations failure, CAS-delete the
 * pending marker (if it's still ours), best-effort `deleteProfile` to clean up
 * the Zernio orphan. connect_state is already gone (GETDEL above).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(req.url);
  const profileIdParam = searchParams.get('profileId');

  // 1. Feature flag — subsystem A is gated by ZERNIO_PUBLISHING_ENABLED (§1.1).
  if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') {
    return redirectError(origin, 'feature_disabled');
  }

  // 2. Parse query params.
  const oauthError = searchParams.get('error');
  const stateParam = searchParams.get('state');
  if (oauthError) {
    if (stateParam) {
      await cleanupAfterOauthDenial(stateParam);
    }
    return redirectError(origin, 'oauth_denied');
  }

  const state = stateParam ?? (await stateFromProfileId(profileIdParam));
  const connectToken =
    searchParams.get('pendingDataToken') ??
    searchParams.get('connect_token') ??
    connectTokenFromState(state);
  const pendingDataToken = searchParams.get('pendingDataToken') ?? connectToken;
  const apiConnectToken = searchParams.get('connect_token') ?? connectTokenFromState(state) ?? undefined;
  if (!state || !pendingDataToken) {
    console.warn(
      `[zernio.callback] missing params keys=${JSON.stringify([
        ...searchParams.keys(),
      ])} state_present=${Boolean(state)} profile_present=${Boolean(
        profileIdParam,
      )} token_present=${Boolean(connectToken)} token_from_state=${Boolean(
        connectTokenFromState(state),
      )}`,
    );
    if (state) {
      await cleanupMissingTokenState(state);
    }
    return redirectError(origin, 'missing_params');
  }

  const redis = getCacheRedis();

  // 3–5. Atomic single-use state claim, first pending verification, re-auth.
  const claim = await claimAndVerifyConnectState(req, state);
  if (!claim.ok) {
    if (claim.cleanupProfileId) {
      await cleanupOrphanedProfileBestEffort(claim.cleanupProfileId);
    }
    return redirectError(origin, claim.code);
  }
  const { stored, pending } = claim;

  // 6. Zernio listLocations + round-11 second pending re-check + stash + cookie.
  // Cleanup-on-failure runs in the catch branch.
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
      await cleanupOrphanedProfileBestEffort(stored.profileId);
      return redirectError(origin, 'flow_cancelled_during_listing');
    }
    let pending2: ConnectPendingMarker;
    try {
      pending2 = JSON.parse(pending2Raw) as ConnectPendingMarker;
    } catch {
      await cleanupOrphanedProfileBestEffort(stored.profileId);
      return redirectError(origin, 'malformed_pending');
    }
    if (
      pending2.flowId !== pending.flowId ||
      pending2.state !== state ||
      pending2.profileId !== stored.profileId ||
      pending2.status !== 'oauth_in_progress'
    ) {
      await cleanupOrphanedProfileBestEffort(stored.profileId);
      return redirectError(origin, 'flow_superseded_during_listing');
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

    // 8. Build 302 redirect with the signed cookie attached.
    const redirectResp = NextResponse.redirect(
      new URL('/dashboard/connect/select-location', origin),
      { status: 302, headers: NO_STORE },
    );
    setConnectSessionCookie(redirectResp, sessionId);
    return redirectResp;
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
    return redirectError(origin, 'zernio_listlocations_failed');
  }
}

function redirectError(origin: string, code: string): NextResponse {
  const target = new URL('/dashboard/connect', origin);
  target.searchParams.set('error', code);
  return NextResponse.redirect(target, { status: 302, headers: NO_STORE });
}
