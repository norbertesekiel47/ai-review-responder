import { NextRequest, NextResponse } from 'next/server';
import { zernioPublishingEnabled } from '@/lib/publishing/flags';
import {
  activeOffboardingStateFromProjection,
  isConnectBlocked,
  type ActiveOffboardingProjection,
} from '@/lib/account-offboarding/gate';
import { sql } from '@/lib/db/server';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { zernioClient } from '@/lib/zernio/client';
import {
  pendingKey,
  profileStateKey,
  luaDeletePendingByFlowIdAnyStatus,
} from '@/lib/zernio/connect-state';
import { setConnectSessionCookie } from '@/lib/zernio/connect-session-cookie';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { cleanupAfterOauthDenial } from '../_shared/callback/oauth-denial';
import { cleanupMissingTokenState } from '../_shared/callback/missing-token';
import { claimAndVerifyConnectState } from '../_shared/callback/claim-and-verify';
import { listLocationsAndStash } from '../_shared/callback/list-and-stash';
import type { ConnectPendingMarker, ConnectStateBlob } from '@/lib/zernio/types';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

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
    reportCaughtError('api/zernio/connect/callback', err, {
      step: 'orphan_profile_cleanup',
      profileId,
    });
  }
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
  if (!zernioPublishingEnabled()) {
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

  // 3–5. Atomic single-use state claim, first pending verification, re-auth.
  const claim = await claimAndVerifyConnectState(req, state);
  if (!claim.ok) {
    if (claim.cleanupProfileId) {
      await cleanupOrphanedProfileBestEffort(claim.cleanupProfileId);
    }
    return redirectError(origin, claim.code);
  }
  const { stored, pending } = claim;

  let business: ({ account_id: string } & ActiveOffboardingProjection) | undefined;
  try {
    business = await loadCallbackBusiness(stored.businessId);
  } catch (err) {
    reportCaughtError('api/zernio/connect/callback', err, {
      step: 'offboarding_lookup',
      businessId: stored.businessId,
    });
    await cleanupBlockedConnectFlow(stored, pending);
    return redirectError(origin, 'internal_error');
  }
  if (!business) {
    await cleanupBlockedConnectFlow(stored, pending);
    return redirectError(origin, 'business_mismatch');
  }
  const offboardingState = activeOffboardingStateFromProjection(business);
  if (isConnectBlocked(offboardingState)) {
    await cleanupBlockedConnectFlow(stored, pending);
    return redirectError(origin, 'account_offboarding_blocked');
  }

  // 6. Zernio listLocations + round-11 second pending re-check + stash.
  // Two distinct failure surfaces: controlled re-verify returns (caller
  // cleans up) vs the thrown catch (cleanup happens in-module).
  const listing = await listLocationsAndStash({
    stored,
    pending,
    state,
    pendingDataToken,
    apiConnectToken,
  });
  if (!listing.ok) {
    if (listing.kind === 'controlled') {
      await cleanupOrphanedProfileBestEffort(listing.cleanupProfileId);
    }
    return redirectError(origin, listing.code);
  }

  // 7. Build 302 redirect with the signed cookie attached.
  const redirectResp = NextResponse.redirect(
    new URL('/dashboard/connect/select-location', origin),
    { status: 302, headers: NO_STORE },
  );
  setConnectSessionCookie(redirectResp, listing.sessionId);
  return redirectResp;
}

function redirectError(origin: string, code: string): NextResponse {
  const target = new URL('/dashboard/connect', origin);
  target.searchParams.set('error', code);
  return NextResponse.redirect(target, { status: 302, headers: NO_STORE });
}

async function loadCallbackBusiness(
  businessId: string,
): Promise<({ account_id: string } & ActiveOffboardingProjection) | undefined> {
  const [business] = await sql<Array<{
    account_id: string;
  } & ActiveOffboardingProjection>>`
    SELECT
      b.account_id,
      ao.id AS offboarding_id,
      ao.account_id AS offboarding_account_id,
      ao.mode AS offboarding_mode,
      ao.status AS offboarding_status,
      ao.failed_step AS offboarding_failed_step,
      ao.access_ends_at AS offboarding_access_ends_at,
      ao.teardown_started_at AS offboarding_teardown_started_at,
      ao.purge_after AS offboarding_purge_after,
      ao.purge_started_at AS offboarding_purge_started_at,
      ao.purge_cancelled_at AS offboarding_purge_cancelled_at
    FROM businesses b
    LEFT JOIN account_offboardings ao
      ON ao.account_id = b.account_id
     AND ao.terminal_at IS NULL
    WHERE b.id = ${businessId}
    ORDER BY ao.created_at DESC NULLS LAST
    LIMIT 1
  `;
  return business;
}

async function cleanupBlockedConnectFlow(
  stored: ConnectStateBlob,
  pending: ConnectPendingMarker,
): Promise<void> {
  const redis = getCacheRedis();
  await redis
    .eval(
      luaDeletePendingByFlowIdAnyStatus,
      1,
      pendingKey(stored.businessId),
      pending.flowId,
    )
    .catch(() => {
      // Best-effort: pending marker auto-expires.
    });
  await zernioClient.deleteProfile(stored.profileId).catch((err) => {
    reportCaughtError('api/zernio/connect/callback', err, {
      step: 'blocked_flow_profile_cleanup',
      profileId: stored.profileId,
      businessId: stored.businessId,
    });
  });
}
