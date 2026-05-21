import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { v7 as uuidv7 } from "uuid";
import { sql, jsonb } from "@/lib/db/server";
import {
  ZernioRouteError,
  ZernioAuthError,
  ZernioValidationError,
} from "@/lib/zernio/errors";
import { SubscriptionStatus } from "@/lib/shared/subscription-status";
import { zernioClient } from "@/lib/zernio/client";
import {
  pendingKey,
  locationsKey,
  luaCASRevertToOauth,
  luaCASToFinalizeUnknown,
  luaDeletePendingByFlowIdAnyStatus,
} from "@/lib/zernio/connect-state";
import { clearConnectSessionCookie } from "@/lib/zernio/connect-session-cookie";
import { authorizeSelectLocation } from "../_shared/finalize/authorize";
import { withFinalizeLock } from "../_shared/finalize/finalize-lock";
import { transitionPendingToFinalizing } from "../_shared/finalize/pending-transition";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private" } as const;

// Pending marker keeps the original 15-min TTL on revert / re-extend.
const PENDING_TTL_SECONDS = 900;

// On finalize_unknown the marker is bumped to 7 days so the owner stays
// blocked from starting a fresh flow until admin reconciles.
const PENDING_FINALIZE_UNKNOWN_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * POST /api/zernio/connect/select-location
 *
 * Spec §3.2 step 3 (round-13 → round-17 corrections). The single most
 * fragile route in the integration: it writes the durable
 * `zernio_connections` row binding a Google account+location to a
 * business. Each numbered step below maps to the spec choreography.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Steps 1–7: feature flag, CSRF, auth, body parse, session cookie,
  // cached-locations load, and auth-scope verify. Validation failures throw
  // ZernioRouteError; untyped errors propagate to errorToResponse below.
  let ctx;
  try {
    ctx = await authorizeSelectLocation(req);
  } catch (err) {
    return errorToResponse(err);
  }
  const { user, sessionId, stored, locationId, redis } = ctx;

  // 7. Acquire the finalize lock; the FULL finalize sequence (8a–8f) runs
  // inside it and the lock is token-CAS released on every exit path.
  try {
    return await withFinalizeLock(redis, sessionId, async () => {
      // 8a + 8b. Read pending marker, sanity-check flowId, CAS
      // oauth_in_progress → finalizing.
      await transitionPendingToFinalizing(redis, stored);

      // 8c. Call Zernio selectLocation, with outcome-known vs outcome-unknown
      // branching on failure (round-14 + round-15 + round-16 + round-17).
      let accountId: string;
      try {
        const result = await zernioClient.selectLocation({
          profileId: stored.profileId,
          pendingDataToken: stored.pending_data_token,
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
          redisMarkedUnknown = result === "OK";
          if (!redisMarkedUnknown) {
            Sentry.captureMessage("zernio_finalize_unknown_redis_cas_failed", {
              level: "error",
              tags: { business_id: stored.businessId },
              extra: {
                flowId: stored.flowId,
                lua_result: String(result),
              },
            });
          }
        } catch (redisErr) {
          Sentry.captureMessage("zernio_finalize_unknown_no_record", {
            level: "fatal",
            tags: { business_id: stored.businessId, kind: "redis_failure" },
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
          if (code === "23505") {
            incidentPersisted = true;
          } else {
            Sentry.captureMessage("zernio_finalize_unknown_db_insert_failed", {
              level: "error",
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
        Sentry.captureMessage("zernio_finalize_unknown", {
          level: "error",
          tags: { business_id: stored.businessId },
          extra: {
            flowId: stored.flowId,
            error:
              zernioErr instanceof Error
                ? zernioErr.message
                : String(zernioErr),
            incidentPersisted,
            redisMarkedUnknown,
          },
        });

        // Step 4 — Controlled 409 instead of bubbling the raw transient error.
        throw new ZernioRouteError(409, "finalize_unknown_admin_required");
      }

      // 8d. DB transaction: INSERT zernio_connections + drain outbox + (on
      // first activation per the needs_backfill predicate) initial-backfill
      // outbox enqueue. All in the same transaction per spec §6.8.
      const newConnectionId = uuidv7();
      try {
        await sql.begin(async (tx) => {
          const [accountLocation] = await tx<
            {
              subscription_status: string;
              subscription_tier: string;
              subscription_activated_at: Date | null;
            }[]
          >`
          SELECT
            a.subscription_status,
            a.subscription_tier,
            a.subscription_activated_at
          FROM businesses b
          JOIN accounts a ON a.id = b.account_id
          WHERE b.id = ${stored.businessId}
            AND b.account_id = ${user.accountId}
            AND b.archived_at IS NULL
          FOR UPDATE OF b, a
        `;

          if (!accountLocation) {
            throw new ZernioRouteError(403, "business_mismatch");
          }
          if (
            accountLocation.subscription_status !== SubscriptionStatus.ACTIVE
          ) {
            throw new ZernioRouteError(403, "subscription_required");
          }

          const [existingConnection] = await tx<{ id: string }[]>`
          SELECT id
          FROM zernio_connections
          WHERE business_id = ${stored.businessId}
            AND status IN ('active', 'pending')
          ORDER BY connected_at DESC NULLS LAST, created_at DESC
          LIMIT 1
          FOR UPDATE
        `;

          const connectionId = existingConnection?.id ?? newConnectionId;
          if (existingConnection) {
            await tx`
            UPDATE zernio_connections
            SET zernio_profile_id = ${stored.profileId},
                zernio_account_id = ${accountId},
                zernio_location_id = ${locationId},
                status = 'active',
                connected_at = NOW(),
                updated_at = NOW()
            WHERE id = ${existingConnection.id}
          `;
          } else {
            await tx`
            INSERT INTO zernio_connections (
              id, business_id, zernio_profile_id, zernio_account_id,
              zernio_location_id, status, connected_at, created_at, updated_at
            ) VALUES (
              ${newConnectionId},
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
          }

          await tx`
          INSERT INTO job_outbox (
            id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
          ) VALUES (
            ${uuidv7()},
            'drain_pending_owner_connect',
            'business',
            ${stored.businessId},
            ${jsonb({ business_id: stored.businessId, kind: "drain" })},
            0,
            5
          )
        `;

          // Backfill-needed predicate (spec §6.8 round-final M2). Fires when
          // EITHER (a) no prior connect existed for this business OR
          // (b) prior connections existed but no backfill has ever COMPLETED
          // (handles the case where a prior backfill auth-failed mid-flight).
          // The worker's ON CONFLICT (business_id) DO NOTHING on
          // zernio_backfill_runs is the second-line guard.
          const [predicate] = await tx<{ needs_backfill: boolean }[]>`
          SELECT (
            NOT EXISTS (
              SELECT 1 FROM zernio_connections
              WHERE business_id = ${stored.businessId}
                AND id != ${connectionId}
                AND connected_at IS NOT NULL
            )
            OR NOT EXISTS (
              SELECT 1 FROM zernio_backfill_runs
              WHERE business_id = ${stored.businessId}
                AND completed_at IS NOT NULL
            )
          ) AS needs_backfill
        `;

          if (predicate?.needs_backfill) {
            if (accountLocation.subscription_activated_at) {
              await tx`
              INSERT INTO job_outbox (
                id, topic, aggregate_type, aggregate_id, payload, status
              ) VALUES (
                ${uuidv7()},
                'zernio_initial_backfill',
                'business',
                ${stored.businessId},
                ${jsonb({
                  business_id: stored.businessId,
                  zernio_account_id: accountId,
                  zernio_location_id: locationId,
                  subscription_tier: accountLocation.subscription_tier,
                  subscription_activated_at:
                    accountLocation.subscription_activated_at.toISOString(),
                  correlation_id: uuidv7(),
                })},
                'pending'
              )
            `;
            } else {
              // Pre-payment connect — connect flow is gated on active
              // subscription upstream, so this branch is unreachable.
              console.warn(
                `[zernio-connect] Connect succeeded but subscription_activated_at NULL for ${stored.businessId}`,
              );
            }
          }
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
            category: "zernio.finalize",
            message: "pending_marker_not_cleared_post_accountid_failure",
            data: { flowId: stored.flowId, cleared: String(cleared) },
          });
        }

        const isUniqueViolation = (dbErr as { code?: string }).code === "23505";
        if (isUniqueViolation) {
          throw new ZernioRouteError(409, "already_connected_by_parallel_flow");
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
    });
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
  if (err instanceof ZernioAuthError) {
    // Outcome-known revert path bubbled up — surface as 502 since Zernio
    // refused at auth layer (likely stale connect_token).
    console.error(
      "[api/zernio/connect/select-location] Zernio auth error:",
      err,
    );
    return NextResponse.json(
      { error: "zernio_auth_error" },
      { status: 502, headers: NO_STORE },
    );
  }
  if (err instanceof ZernioValidationError) {
    // Outcome-known revert path bubbled up — pre-mutation reject.
    console.error(
      "[api/zernio/connect/select-location] Zernio validation error:",
      err,
    );
    return NextResponse.json(
      { error: "zernio_validation_error", code: err.code },
      { status: 400, headers: NO_STORE },
    );
  }
  console.error("[api/zernio/connect/select-location] internal error:", err);
  return NextResponse.json(
    { error: "internal_error" },
    { status: 500, headers: NO_STORE },
  );
}
