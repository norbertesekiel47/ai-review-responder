import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { requireRole, AuthError } from '@/lib/db/auth';
import { ZernioRouteError } from '@/lib/zernio/errors';
import { zernioClient } from '@/lib/zernio/client';
import {
  pendingKey,
  stateKey,
  locationsKey,
  luaCASCancel,
} from '@/lib/zernio/connect-state';
import {
  readConnectSessionCookie,
  clearConnectSessionCookie,
} from '@/lib/zernio/connect-session-cookie';
import type { ConnectPendingMarker } from '@/lib/zernio/types';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

/**
 * POST /api/zernio/connect/cancel
 *
 * Spec §3.2 step 4 (round-8 addition + round-11/13/14 corrections). Owner-
 * initiated cancel of an in-flight OAuth flow. Mutates Redis state and
 * best-effort Zernio Profile state, so it requires the same auth+CSRF
 * posture as connect/start and disconnect.
 *
 * Branches on the luaCASCancel return value:
 *   1  → we successfully cancelled OUR flow → cleanup + 200 cancelled:true
 *   0  → marker missing or different flowId → 200 cancelled:false (benign no-op)
 *  -1  → status='finalizing' → 409 finalize_in_progress
 *  -2  → status='finalize_unknown' → 409 finalize_unknown_admin_required
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Feature flag — subsystem A is gated by ZERNIO_PUBLISHING_ENABLED (§1.1).
  if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'feature_disabled' },
      { status: 503, headers: NO_STORE },
    );
  }

  // 1. CSRF (FIRST, before any side-effecting work — spec §3.2 step 4).
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json(
        { error: 'forbidden' },
        { status: 403, headers: NO_STORE },
      );
    }
    return errorToResponse(err);
  }

  // 2. Auth — owner only; null businessId is the unscoped-owner edge case.
  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.statusCode === 401 ? 'unauthorized' : 'forbidden' },
        { status: err.statusCode, headers: NO_STORE },
      );
    }
    return errorToResponse(err);
  }
  if (!user.businessId) {
    return NextResponse.json(
      { error: 'unscoped_owner' },
      { status: 403, headers: NO_STORE },
    );
  }
  const businessId = user.businessId;

  const redis = getCacheRedis();
  const pKey = pendingKey(businessId);

  try {
    // 3. Read the pending marker. Missing = nothing to cancel = success no-op.
    const pendingRaw = await redis.get(pKey);
    if (!pendingRaw) {
      return NextResponse.json(
        { cancelled: false, reason: 'no_in_flight_flow' },
        { status: 200, headers: NO_STORE },
      );
    }

    // 4. Round-13: parse defensively. A malformed marker should not 500;
    // surface a 409 so the owner gets a clear error instead of a generic
    // server error.
    let parsed: ConnectPendingMarker;
    try {
      parsed = JSON.parse(pendingRaw) as ConnectPendingMarker;
    } catch {
      Sentry.captureMessage('zernio_malformed_pending_marker_in_cancel', {
        level: 'warning',
        tags: { business_id: businessId },
      });
      return NextResponse.json(
        { cancelled: false, reason: 'malformed_pending_marker' },
        { status: 409, headers: NO_STORE },
      );
    }

    // 5. Defensive ownership check — same business, different owner-session
    // shouldn't be possible in v1 (one owner per business) but the guard is
    // cheap and preserves the invariant.
    if (parsed.userId !== user.id) {
      return NextResponse.json(
        { cancelled: false, reason: 'user_mismatch' },
        { status: 403, headers: NO_STORE },
      );
    }

    // 6. CAS-delete the pending marker by flowId, refusing 'finalizing' /
    // 'finalize_unknown' (round-11 + round-14).
    const result = await redis.eval(luaCASCancel, 1, pKey, parsed.flowId);

    if (result === -1) {
      // Finalize already in flight; cancel must NOT touch state/cookie/profile.
      return NextResponse.json(
        { cancelled: false, reason: 'finalize_in_progress' },
        { status: 409, headers: NO_STORE },
      );
    }
    if (result === -2) {
      // finalize_unknown — needs admin reconciliation. Owner cancel must NOT
      // erase the marker (it carries flowId/profileId/finalize_unknown_at
      // that the runbook procedure relies on).
      return NextResponse.json(
        { cancelled: false, reason: 'finalize_unknown_admin_required' },
        { status: 409, headers: NO_STORE },
      );
    }
    if (result === 0) {
      // Different flow occupies the slot OR marker disappeared mid-cancel.
      // Don't touch the other flow's state/profile.
      return NextResponse.json(
        { cancelled: false, reason: 'flow_changed_during_cancel' },
        { status: 200, headers: NO_STORE },
      );
    }

    // result === 1: we successfully cancelled OUR flow. Safe to clean up.

    // 7a. Best-effort delete of the connect_state key (used during OAuth
    // callback). Only the marker carries the state value reliably.
    if (parsed.state) {
      await redis.del(stateKey(parsed.state)).catch(() => {
        // Best-effort: state auto-expires.
      });
    }

    // 7b. Best-effort delete of the locations blob (only present after the
    // callback ran). Cookie may be absent if cancel happens during the OAuth
    // step before the callback completes — that's fine.
    const sessionId = readConnectSessionCookie(req);
    if (sessionId) {
      await redis.del(locationsKey(sessionId)).catch(() => {
        // Best-effort: blob auto-expires.
      });
    }

    // 7c. Best-effort delete of the orphan Zernio Profile. Failures here
    // don't fail the cancel — the user can still restart since the local
    // pending marker is gone, and orphan profiles are cheap.
    if (parsed.profileId) {
      try {
        await zernioClient.deleteProfile(parsed.profileId);
      } catch (profileErr) {
        Sentry.captureException(profileErr, {
          tags: { business_id: businessId, kind: 'zernio_delete_profile' },
        });
      }
    }

    // 7d. Build response and clear cookie. clearConnectSessionCookie is a
    // no-op when no cookie is set, so it's safe to call unconditionally.
    const response = NextResponse.json(
      { cancelled: true, reason: 'flow_cancelled' },
      { status: 200, headers: NO_STORE },
    );
    clearConnectSessionCookie(response);
    return response;
  } catch (err) {
    return errorToResponse(err);
  }
}

function errorToResponse(err: unknown): NextResponse {
  if (err instanceof ZernioRouteError) {
    return NextResponse.json(
      { error: err.code },
      { status: err.statusCode, headers: NO_STORE },
    );
  }
  console.error('[api/zernio/connect/cancel] internal error:', err);
  return NextResponse.json(
    { error: 'internal_error' },
    { status: 500, headers: NO_STORE },
  );
}
