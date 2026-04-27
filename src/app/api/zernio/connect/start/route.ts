import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { requireRole, AuthError } from '@/lib/db/auth';
import { ZernioRouteError } from '@/lib/zernio/errors';
import { zernioClient } from '@/lib/zernio/client';
import {
  pendingKey,
  stateKey,
  lockKey,
  generateFlowId,
  generateState,
  generateLockToken,
  luaTokenCAS,
  luaCASUpdate,
  luaCASDel,
} from '@/lib/zernio/connect-state';
import type { ConnectPendingMarker, ConnectStateBlob } from '@/lib/zernio/types';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;
const PENDING_TTL_SECONDS = 900; // 15 min — matches Zernio connect_token TTL
const LOCK_TTL_SECONDS = 30;

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Feature flag — subsystem A is flag-gated by ZERNIO_PUBLISHING_ENABLED (§1.1).
  if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503, headers: NO_STORE });
  }

  // 1. CSRF (FIRST, before any DB or external work — round-7 correction).
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    return errorToResponse(err);
  }

  // 2. Auth.
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

  // Round-9: AppUser uses camelCase businessId (TS); requireRole does NOT
  // guarantee non-null business scope.
  if (!user.businessId) {
    return NextResponse.json({ error: 'unscoped_owner' }, { status: 403, headers: NO_STORE });
  }
  const businessId = user.businessId;
  const userId = user.id;

  // 3. Subscription guard — spec §3.2 step 1: skip if subscription_status != 'active'.
  try {
    const bizRows = await sql<{ subscription_status: string }[]>`
      SELECT subscription_status
      FROM businesses
      WHERE id = ${businessId}
      LIMIT 1
    `;
    const biz = bizRows[0];
    if (!biz) {
      return NextResponse.json({ error: 'business_not_found' }, { status: 404, headers: NO_STORE });
    }
    if (biz.subscription_status !== 'active') {
      return NextResponse.json(
        { error: 'subscription_required' },
        { status: 403, headers: NO_STORE },
      );
    }
  } catch (err) {
    return errorToResponse(err);
  }

  const redis = getCacheRedis();
  const pKey = pendingKey(businessId);
  const lKey = lockKey(businessId);

  // 4. Step A — Pending-flow marker check (long-lived, 15-min TTL).
  try {
    const existingPending = await redis.get(pKey);
    if (existingPending) {
      let parsed: ConnectPendingMarker | null = null;
      try {
        parsed = JSON.parse(existingPending) as ConnectPendingMarker;
      } catch {
        return NextResponse.json(
          { error: 'malformed_pending_marker' },
          { status: 409, headers: NO_STORE },
        );
      }
      // Defensive: if started >15 min ago, the TTL should have already
      // expired but Redis clock skew or a freshly-bumped marker can leave
      // a stale entry. Fall through and recreate in that case.
      const ageMs = Date.now() - (parsed.started_at ?? 0);
      const fifteenMinMs = PENDING_TTL_SECONDS * 1000;
      if (ageMs <= fifteenMinMs) {
        return NextResponse.json(
          { error: 'connect_pending', status: parsed.status },
          { status: 409, headers: NO_STORE },
        );
      }
      // else: fall through and recreate — let Step C overwrite the stale marker.
    }
  } catch (err) {
    return errorToResponse(err);
  }

  // 5. Step B — Request lock (short-lived, 30s TTL, token-stamped).
  const lockToken = generateLockToken();
  try {
    const acquired = await redis.set(lKey, lockToken, 'EX', LOCK_TTL_SECONDS, 'NX');
    if (!acquired) {
      return NextResponse.json(
        { error: 'connect_in_progress' },
        { status: 429, headers: NO_STORE },
      );
    }
  } catch (err) {
    return errorToResponse(err);
  }

  // Variables hoisted so Step F catch can reach them regardless of which sub-step threw.
  const startedAt = Date.now();
  const flowId = generateFlowId();
  let placeholderRaw: string | null = null;
  let createdState: string | null = null;
  let createdProfileId: string | null = null;

  try {
    // 6. Step B-bis — DB idempotency check BEFORE planting the marker.
    const existingActive = await sql<{ exists: number }[]>`
      SELECT 1 AS exists
      FROM zernio_connections
      WHERE business_id = ${businessId} AND status IN ('pending', 'active')
      LIMIT 1
    `;
    if (existingActive.length > 0) {
      throw new ZernioRouteError(409, 'already_connected');
    }

    // 7. Step B-tris (round-15) — block if a finalize_unknown incident is unresolved.
    const unresolvedIncident = await sql<{ exists: number }[]>`
      SELECT 1 AS exists
      FROM zernio_finalize_incidents
      WHERE business_id = ${businessId} AND resolved_at IS NULL
      LIMIT 1
    `;
    if (unresolvedIncident.length > 0) {
      throw new ZernioRouteError(409, 'finalize_unknown_admin_required');
    }

    // 8. Step C — PLACEHOLDER pending marker, BEFORE any external call.
    const placeholderMarker: ConnectPendingMarker = {
      flowId,
      userId,
      started_at: startedAt,
      status: 'starting',
    };
    placeholderRaw = JSON.stringify(placeholderMarker);
    await redis.set(pKey, placeholderRaw, 'EX', PENDING_TTL_SECONDS);

    try {
      // 9. Step D — Start work (now safely behind the pending marker).
      const profileIdPrefix = process.env.ZERNIO_PROFILE_ID_PREFIX ?? 'repworth-prod-';
      const { profileId } = await zernioClient.createProfile({
        name: `${profileIdPrefix}${businessId}`,
      });
      createdProfileId = profileId;

      const state = generateState();
      const stateBlob: ConnectStateBlob = {
        businessId,
        profileId,
        userId,
        createdAt: startedAt,
      };
      await redis.setex(stateKey(state), PENDING_TTL_SECONDS, JSON.stringify(stateBlob));
      createdState = state;

      const appUrl = process.env.NEXT_PUBLIC_APP_URL;
      if (!appUrl) {
        throw new ZernioRouteError(500, 'app_url_not_configured');
      }
      const redirectUrl = `${appUrl}/api/zernio/connect/callback`;
      const { authUrl } = await zernioClient.startConnect({
        profileId,
        state,
        redirectUrl,
      });

      // 10. Step E — Update pending marker with profileId + state via CAS.
      const fullMarker: ConnectPendingMarker = {
        flowId,
        userId,
        started_at: startedAt,
        status: 'oauth_in_progress',
        profileId,
        state,
      };
      const updateResult = await redis.eval(
        luaCASUpdate,
        1,
        pKey,
        placeholderRaw,
        JSON.stringify(fullMarker),
        String(PENDING_TTL_SECONDS),
      );
      if (!updateResult) {
        // Marker overwritten/deleted by a newer flow — our flow is superseded.
        throw new ZernioRouteError(409, 'flow_superseded_during_start');
      }

      return NextResponse.json({ authUrl }, { status: 200, headers: NO_STORE });
    } catch (startErr) {
      // 11. Step F — Failure cleanup. CAS-delete only if marker is still ours.
      if (placeholderRaw) {
        await redis
          .eval(luaCASDel, 1, pKey, placeholderRaw)
          .catch(() => {
            // Best-effort: marker either gone or overwritten; leave it alone.
          });
      }
      if (createdState) {
        await redis.del(stateKey(createdState)).catch(() => {
          // Best-effort.
        });
      }
      if (createdProfileId) {
        await zernioClient.deleteProfile(createdProfileId).catch(() => {
          // Best-effort orphan cleanup at Zernio.
        });
      }
      throw startErr;
    }
  } catch (err) {
    return errorToResponse(err);
  } finally {
    // 12. Lock release — compare-and-delete (token-stamped).
    await redis.eval(luaTokenCAS, 1, lKey, lockToken).catch(() => {
      // Best-effort: if the lock was already released or ownership changed,
      // the 30s TTL is the safety net.
    });
  }
}

function errorToResponse(err: unknown): NextResponse {
  if (err instanceof ZernioRouteError) {
    return NextResponse.json(
      { error: err.code },
      { status: err.statusCode, headers: NO_STORE },
    );
  }
  console.error('[api/zernio/connect/start] internal error:', err);
  return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: NO_STORE });
}
