import { NextRequest, NextResponse } from 'next/server';
import {
  ZernioAuthError,
  ZernioValidationError,
} from '@/lib/zernio/errors';
import { zernioRouteErrorResponse } from '@/app/api/zernio/_shared/error-response';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { sql } from '@/lib/db/server';
import { zernioClient } from '@/lib/zernio/client';
import {
  pendingKey,
  locationsKey,
  luaCASRevertToOauth,
  luaDeletePendingByFlowIdAnyStatus,
} from '@/lib/zernio/connect-state';
import { clearConnectSessionCookie } from '@/lib/zernio/connect-session-cookie';
import { authorizeSelectLocation } from '../_shared/finalize/authorize';
import { withFinalizeLock } from '../_shared/finalize/finalize-lock';
import { transitionPendingToFinalizing } from '../_shared/finalize/pending-transition';
import { recordFinalizeUnknownAndThrow } from '../_shared/finalize/finalize-unknown';
import { finalizeConnectionTx } from '../_shared/finalize/finalize-tx';
import { recoverFromFinalizeTxFailure } from '../_shared/finalize/orphan-recovery';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

// Pending marker keeps the original 15-min TTL on revert / re-extend.
const PENDING_TTL_SECONDS = 900;

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
    ctx = await authorizeSelectLocation(sql, req);
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

        // OUTCOME UNKNOWN — record incident (non-fatal) and always 409.
        return recordFinalizeUnknownAndThrow(sql, { redis, stored, zernioErr });
      }

      // 8d. Single durable finalize transaction (connection upsert + outbox
      // drain + conditional initial-backfill enqueue).
      try {
        await finalizeConnectionTx(sql, { user, stored, locationId, accountId });
      } catch (dbErr) {
        // 8e. Post-accountId orphan recovery (best-effort cleanup; 23505 → 409
        // already_connected_by_parallel_flow, otherwise rethrow).
        return recoverFromFinalizeTxFailure({
          redis,
          stored,
          accountId,
          dbErr,
        });
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
  if (err instanceof ZernioAuthError) {
    // Outcome-known revert path bubbled up — surface as 502 since Zernio
    // refused at auth layer (likely stale connect_token).
    reportCaughtError('api/zernio/connect/select-location', err, {
      kind: 'zernio_auth_error',
    });
    return NextResponse.json(
      { error: 'zernio_auth_error' },
      { status: 502, headers: NO_STORE },
    );
  }
  if (err instanceof ZernioValidationError) {
    // Outcome-known revert path bubbled up — pre-mutation reject.
    reportCaughtError('api/zernio/connect/select-location', err, {
      kind: 'zernio_validation_error',
      code: err.code,
    });
    return NextResponse.json(
      { error: 'zernio_validation_error', code: err.code },
      { status: 400, headers: NO_STORE },
    );
  }
  // ZernioRouteError → (code, status); else logged 500. NO_STORE on both.
  return zernioRouteErrorResponse(err, '[api/zernio/connect/select-location]');
}
