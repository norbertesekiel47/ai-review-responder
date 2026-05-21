import * as Sentry from '@sentry/nextjs';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { ZernioRouteError } from '@/lib/zernio/errors';
import { pendingKey, luaCASToFinalizing } from '@/lib/zernio/connect-state';
import type { ConnectLocationsBlob } from '@/lib/zernio/types';

type CacheRedis = ReturnType<typeof getCacheRedis>;

// Pending marker keeps the original 15-min TTL on revert / re-extend.
const PENDING_TTL_SECONDS = 900;

/**
 * Steps 8a + 8b: read the pending marker, sanity-check its flowId, then CAS its
 * status oauth_in_progress → finalizing. All lua-result decoding maps to the
 * exact `ZernioRouteError(status, code)` the route surfaced inline. Returns on
 * success; throws on any failure.
 */
export async function transitionPendingToFinalizing(
  redis: CacheRedis,
  stored: ConnectLocationsBlob,
): Promise<void> {
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
}
