import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { requireRole, AuthError } from '@/lib/db/auth';
import {
  ZernioRouteError,
  ZernioAuthError,
  ZernioValidationError,
} from '@/lib/zernio/errors';
import { zernioClient } from '@/lib/zernio/client';
import {
  pendingKey,
  locationsKey,
  finalizeLockKey,
  generateLockToken,
  luaCASToFinalizing,
  luaCASRevertToOauth,
  luaCASToFinalizeUnknown,
  luaDeletePendingByFlowIdAnyStatus,
  luaTokenCAS,
} from '@/lib/zernio/connect-state';
import {
  readConnectSessionCookie,
  clearConnectSessionCookie,
} from '@/lib/zernio/connect-session-cookie';
import type { ConnectLocationsBlob } from '@/lib/zernio/types';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

// Spec §3.2 step 3: lock TTL widened from 30s → 60s to comfortably cover
// the Zernio call (15s budget) + DB tx + 3 Redis ops + cookie set, even
// on a slow network.
const FINALIZE_LOCK_TTL_SECONDS = 60;

// Pending marker keeps the original 15-min TTL on revert / re-extend.
const PENDING_TTL_SECONDS = 900;

// On finalize_unknown the marker is bumped to 7 days so the owner stays
// blocked from starting a fresh flow until admin reconciles.
const PENDING_FINALIZE_UNKNOWN_TTL_SECONDS = 60 * 60 * 24 * 7;

interface SelectLocationBody {
  locationId?: unknown;
}

/**
 * POST /api/zernio/connect/select-location
 *
 * Spec §3.2 step 3 (round-13 → round-17 corrections). The single most
 * fragile route in the integration: it writes the durable
 * `zernio_connections` row binding a Google account+location to a
 * business. Each numbered step below maps to the spec choreography.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Feature flag — subsystem A is gated by ZERNIO_PUBLISHING_ENABLED (§1.1).
  if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'feature_disabled' },
      { status: 503, headers: NO_STORE },
    );
  }

  // 1. CSRF (FIRST, before any DB or external work).
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
  if (!user.businessId) {
    return NextResponse.json(
      { error: 'unscoped_owner' },
      { status: 403, headers: NO_STORE },
    );
  }

  // 3. Parse body.
  let body: SelectLocationBody;
  try {
    body = (await req.json()) as SelectLocationBody;
  } catch {
    return NextResponse.json(
      { error: 'invalid_body' },
      { status: 400, headers: NO_STORE },
    );
  }
  const locationId =
    typeof body.locationId === 'string' && body.locationId.length > 0
      ? body.locationId
      : null;
  if (!locationId) {
    return NextResponse.json(
      { error: 'invalid_location_id' },
      { status: 400, headers: NO_STORE },
    );
  }

  // 4. Read signed cookie → sessionId.
  const sessionId = readConnectSessionCookie(req);
  if (!sessionId) {
    return NextResponse.json(
      { error: 'connect_session_missing' },
      { status: 401, headers: NO_STORE },
    );
  }

  const redis = getCacheRedis();

  // 5. Load the cached locations blob.
  let stored: ConnectLocationsBlob;
  try {
    const raw = await redis.get(locationsKey(sessionId));
    if (!raw) {
      return NextResponse.json(
        { error: 'connect_session_expired' },
        { status: 410, headers: NO_STORE },
      );
    }
    try {
      stored = JSON.parse(raw) as ConnectLocationsBlob;
    } catch {
      return NextResponse.json(
        { error: 'connect_session_expired' },
        { status: 410, headers: NO_STORE },
      );
    }
  } catch (err) {
    return errorToResponse(err);
  }

  // 6. Auth-scope verify (defence-in-depth — cookie alone is insufficient).
  if (stored.userId !== user.id) {
    return NextResponse.json(
      { error: 'user_mismatch' },
      { status: 403, headers: NO_STORE },
    );
  }
  if (stored.businessId !== user.businessId) {
    return NextResponse.json(
      { error: 'business_mismatch' },
      { status: 403, headers: NO_STORE },
    );
  }
  const locationKnown = stored.locations.some((loc) => loc.id === locationId);
  if (!locationKnown) {
    return NextResponse.json(
      { error: 'invalid_location_id' },
      { status: 400, headers: NO_STORE },
    );
  }

  // 7. Acquire finalize lock — the FULL finalize sequence happens inside it
  // (round-7 correction). 60s TTL covers Zernio call + DB tx + 3 Redis ops
  // + cookie set; explicit release in finally on every path.
  const finalizeKey = finalizeLockKey(sessionId);
  const finalizeToken = generateLockToken();
  let acquired: 'OK' | null;
  try {
    acquired = await redis.set(
      finalizeKey,
      finalizeToken,
      'EX',
      FINALIZE_LOCK_TTL_SECONDS,
      'NX',
    );
  } catch (err) {
    return errorToResponse(err);
  }
  if (!acquired) {
    return NextResponse.json(
      { error: 'finalize_in_progress' },
      { status: 409, headers: NO_STORE },
    );
  }

  try {
    // 8a. Read pending marker; sanity-check flowId.
    const pendingRaw = await redis.get(pendingKey(stored.businessId));
    if (!pendingRaw) {
      throw new ZernioRouteError(410, 'connect_pending_missing');
    }
    let parsedPending: { flowId?: string; status?: string } | null;
    try {
      parsedPending = JSON.parse(pendingRaw) as {
        flowId?: string;
        status?: string;
      };
    } catch {
      throw new ZernioRouteError(409, 'malformed_pending_marker');
    }
    if (parsedPending.flowId !== stored.flowId) {
      throw new ZernioRouteError(410, 'flow_changed');
    }

    // 8b. CAS pending status oauth_in_progress → finalizing.
    const transitioned = await redis.eval(
      luaCASToFinalizing,
      1,
      pendingKey(stored.businessId),
      stored.flowId,
      String(PENDING_TTL_SECONDS),
    );
    if (transitioned === 'OK') {
      // success — fall through
    } else if (transitioned === 0) {
      throw new ZernioRouteError(410, 'flow_changed');
    } else if (transitioned === -1) {
      throw new ZernioRouteError(410, 'connect_pending_missing');
    } else if (transitioned === -2) {
      throw new ZernioRouteError(409, 'malformed_pending_marker');
    } else if (transitioned === -3) {
      // Marker is already 'finalizing' or 'finalize_unknown' — refuse to
      // double-call the non-idempotent selectLocation (round-13).
      throw new ZernioRouteError(409, 'finalize_in_progress');
    } else {
      // Unexpected return value — fail closed.
      Sentry.captureMessage('zernio_select_location_unexpected_lua_result', {
        level: 'error',
        tags: { business_id: stored.businessId },
        extra: { flowId: stored.flowId, lua_result: String(transitioned) },
      });
      throw new ZernioRouteError(409, 'finalize_in_progress');
    }

    // 8c. Call Zernio selectLocation, with outcome-known vs outcome-unknown
    // branching on failure (round-14 + round-15 + round-16 + round-17).
    let accountId: string;
    try {
      const result = await zernioClient.selectLocation({
        connectToken: stored.connect_token,
        locationId,
      });
      accountId = result.accountId;
    } catch (zernioErr) {
      const isOutcomeKnown =
        zernioErr instanceof ZernioAuthError ||
        zernioErr instanceof ZernioValidationError;

      if (isOutcomeKnown) {
        // Pre-mutation reject → revert finalizing → oauth_in_progress so
        // the owner can retry or cancel cleanly. Best-effort.
        await redis
          .eval(
            luaCASRevertToOauth,
            1,
            pendingKey(stored.businessId),
            stored.flowId,
            String(PENDING_TTL_SECONDS),
          )
          .catch(() => {
            // Best-effort: marker auto-expires; original error still bubbles.
          });
        throw zernioErr;
      }

      // OUTCOME UNKNOWN — round-15 + round-16 + round-17 sequence:
      //   Step 1: Redis CAS finalizing → finalize_unknown (7-day TTL).
      //   Step 2: INSERT INTO zernio_finalize_incidents (durable record).
      //   Step 3: Sentry alert.
      //   Step 4: throw ZernioRouteError(409, 'finalize_unknown_admin_required').
      const finalizeUnknownAt = new Date();

      // Step 1 — Redis 7-day update. Round-17: CHECK return value; only
      // "OK" counts as success.
      let redisMarkedUnknown = false;
      try {
        const result = await redis.eval(
          luaCASToFinalizeUnknown,
          1,
          pendingKey(stored.businessId),
          stored.flowId,
          String(PENDING_FINALIZE_UNKNOWN_TTL_SECONDS),
          finalizeUnknownAt.toISOString(),
        );
        redisMarkedUnknown = result === 'OK';
        if (!redisMarkedUnknown) {
          Sentry.captureMessage('zernio_finalize_unknown_redis_cas_failed', {
            level: 'error',
            tags: { business_id: stored.businessId },
            extra: {
              flowId: stored.flowId,
              lua_result: String(result),
            },
          });
        }
      } catch (redisErr) {
        Sentry.captureMessage('zernio_finalize_unknown_no_record', {
          level: 'fatal',
          tags: { business_id: stored.businessId, kind: 'redis_failure' },
          extra: {
            flowId: stored.flowId,
            redisErr:
              redisErr instanceof Error ? redisErr.message : String(redisErr),
          },
        });
      }

      // Step 2 — Durable DB incident row. Idempotent on 23505 (existing
      // unresolved incident already covers this business).
      let incidentPersisted = false;
      try {
        await sql`
          INSERT INTO zernio_finalize_incidents (
            id, business_id, zernio_profile_id, flow_id, finalize_unknown_at
          ) VALUES (
            ${uuidv7()},
            ${stored.businessId},
            ${stored.profileId},
            ${stored.flowId},
            ${finalizeUnknownAt}
          )
        `;
        incidentPersisted = true;
      } catch (incidentErr) {
        const code = (incidentErr as { code?: string }).code;
        if (code === '23505') {
          incidentPersisted = true;
        } else {
          Sentry.captureMessage('zernio_finalize_unknown_db_insert_failed', {
            level: 'error',
            tags: { business_id: stored.businessId },
            extra: {
              flowId: stored.flowId,
              dbErr:
                incidentErr instanceof Error
                  ? incidentErr.message
                  : String(incidentErr),
            },
          });
        }
      }

      // Step 3 — Always-on Sentry alert (additive to the worst-case
      // alerts above).
      Sentry.captureMessage('zernio_finalize_unknown', {
        level: 'error',
        tags: { business_id: stored.businessId },
        extra: {
          flowId: stored.flowId,
          error:
            zernioErr instanceof Error ? zernioErr.message : String(zernioErr),
          incidentPersisted,
          redisMarkedUnknown,
        },
      });

      // Step 4 — Controlled 409 instead of bubbling the raw transient error.
      throw new ZernioRouteError(409, 'finalize_unknown_admin_required');
    }

    // 8d. DB transaction: INSERT zernio_connections + drain outbox.
    try {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO zernio_connections (
            id, business_id, zernio_profile_id, zernio_account_id,
            zernio_location_id, status, connected_at, created_at, updated_at
          ) VALUES (
            ${uuidv7()},
            ${stored.businessId},
            ${stored.profileId},
            ${accountId},
            ${locationId},
            'active',
            NOW(),
            NOW(),
            NOW()
          )
        `;

        await tx`
          INSERT INTO job_outbox (
            id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
          ) VALUES (
            ${uuidv7()},
            'drain_pending_owner_connect',
            'business',
            ${stored.businessId},
            ${jsonb({ business_id: stored.businessId, kind: 'drain' })},
            0,
            5
          )
        `;
      });
    } catch (dbErr) {
      // 8e. Round-12 + round-13 post-accountId recovery. Zernio committed
      // server-side but our durable DB row doesn't exist yet. Two failure
      // modes — same recovery, different surface:
      //   (a) 23505 unique violation → another flow finalized first; OUR
      //       accountId is now an orphan. 409 already_connected_by_parallel_flow.
      //   (b) any other DB error → still an orphan; bubble the original
      //       error up so it surfaces as 500.
      // Both branches: best-effort delete the orphan Zernio account and
      // best-effort clear the pending marker (luaDeletePendingByFlowIdAnyStatus,
      // NOT luaCASCancel which would refuse the 'finalizing' status).
      await zernioClient.deleteAccount(accountId).catch(() => {
        // Best-effort: orphan stays at Zernio, will be cleaned up by ops.
      });

      const cleared = await redis
        .eval(
          luaDeletePendingByFlowIdAnyStatus,
          1,
          pendingKey(stored.businessId),
          stored.flowId,
        )
        .catch(() => 0);
      if (cleared !== 1) {
        Sentry.addBreadcrumb({
          category: 'zernio.finalize',
          message: 'pending_marker_not_cleared_post_accountid_failure',
          data: { flowId: stored.flowId, cleared: String(cleared) },
        });
      }

      const isUniqueViolation = (dbErr as { code?: string }).code === '23505';
      if (isUniqueViolation) {
        throw new ZernioRouteError(409, 'already_connected_by_parallel_flow');
      }
      throw dbErr;
    }

    // 8f. Full success — clear pending marker (any status, by flowId),
    // drop the locations blob, clear the cookie, return 200.
    await redis
      .eval(
        luaDeletePendingByFlowIdAnyStatus,
        1,
        pendingKey(stored.businessId),
        stored.flowId,
      )
      .catch(() => {
        // Best-effort: marker auto-expires.
      });

    await redis.del(locationsKey(sessionId)).catch(() => {
      // Best-effort: cached locations auto-expire.
    });

    const response = NextResponse.json(
      { ok: true },
      { status: 200, headers: NO_STORE },
    );
    clearConnectSessionCookie(response);
    return response;
  } catch (err) {
    return errorToResponse(err);
  } finally {
    // 9. Release the finalize lock — token-stamped CAS so we never
    // accidentally release a lock acquired by a parallel finalize.
    await redis.eval(luaTokenCAS, 1, finalizeKey, finalizeToken).catch(() => {
      // Best-effort: 60s TTL is the safety net.
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
  if (err instanceof ZernioAuthError) {
    // Outcome-known revert path bubbled up — surface as 502 since Zernio
    // refused at auth layer (likely stale connect_token).
    console.error(
      '[api/zernio/connect/select-location] Zernio auth error:',
      err,
    );
    return NextResponse.json(
      { error: 'zernio_auth_error' },
      { status: 502, headers: NO_STORE },
    );
  }
  if (err instanceof ZernioValidationError) {
    // Outcome-known revert path bubbled up — pre-mutation reject.
    console.error(
      '[api/zernio/connect/select-location] Zernio validation error:',
      err,
    );
    return NextResponse.json(
      { error: 'zernio_validation_error', code: err.code },
      { status: 400, headers: NO_STORE },
    );
  }
  console.error('[api/zernio/connect/select-location] internal error:', err);
  return NextResponse.json(
    { error: 'internal_error' },
    { status: 500, headers: NO_STORE },
  );
}
