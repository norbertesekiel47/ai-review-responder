import * as Sentry from '@sentry/nextjs';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { ZernioRouteError } from '@/lib/zernio/errors';
import {
  pendingKey,
  luaCASToFinalizeUnknown,
} from '@/lib/zernio/connect-state';
import type { ConnectLocationsBlob } from '@/lib/zernio/types';

type CacheRedis = ReturnType<typeof getCacheRedis>;

// On finalize_unknown the marker is bumped to 7 days so the owner stays
// blocked from starting a fresh flow until admin reconciles.
const PENDING_FINALIZE_UNKNOWN_TTL_SECONDS = 60 * 60 * 24 * 7;

interface RecordFinalizeUnknownArgs {
  redis: CacheRedis;
  stored: ConnectLocationsBlob;
  zernioErr: unknown;
}

/**
 * Step 8c OUTCOME-UNKNOWN incident path (round-15 + round-16 + round-17).
 *
 * The Zernio call failed with an UNKNOWN outcome — it may have committed
 * server-side. This records the incident as durably as possible and ALWAYS
 * throws `ZernioRouteError(409, 'finalize_unknown_admin_required')`. Both inner
 * failure modes (Redis CAS reject and DB insert reject) are individually caught
 * and reported to Sentry; NEITHER may rethrow / bubble as a 500. The function
 * never returns normally (`Promise<never>`).
 */
export async function recordFinalizeUnknownAndThrow({
  redis,
  stored,
  zernioErr,
}: RecordFinalizeUnknownArgs): Promise<never> {
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
      error: zernioErr instanceof Error ? zernioErr.message : String(zernioErr),
      incidentPersisted,
      redisMarkedUnknown,
    },
  });

  // Step 4 — Controlled 409 instead of bubbling the raw transient error.
  throw new ZernioRouteError(409, 'finalize_unknown_admin_required');
}
