import * as Sentry from "@sentry/nextjs";
import { getCacheRedis } from "@/lib/db/redis-cache";
import { ZernioRouteError } from "@/lib/zernio/errors";
import { zernioClient } from "@/lib/zernio/client";
import {
  pendingKey,
  luaDeletePendingByFlowIdAnyStatus,
} from "@/lib/zernio/connect-state";
import type { ConnectLocationsBlob } from "@/lib/zernio/types";

type CacheRedis = ReturnType<typeof getCacheRedis>;

interface RecoverFromFinalizeTxFailureArgs {
  redis: CacheRedis;
  stored: ConnectLocationsBlob;
  accountId: string;
  dbErr: unknown;
}

/**
 * Step 8e: post-accountId orphan recovery (round-12 + round-13). The Zernio
 * account committed server-side but our durable DB row does not exist. Two
 * failure modes, same recovery, different surface:
 *   (a) 23505 unique violation → another flow finalized first; OUR accountId is
 *       an orphan. 409 already_connected_by_parallel_flow.
 *   (b) any other DB error → still an orphan; rethrow the original error so it
 *       surfaces as 500.
 * Both branches best-effort delete the orphan Zernio account and best-effort
 * clear the pending marker (luaDeletePendingByFlowIdAnyStatus, NOT luaCASCancel
 * which would refuse the 'finalizing' status). Never returns normally.
 */
export async function recoverFromFinalizeTxFailure({
  redis,
  stored,
  accountId,
  dbErr,
}: RecoverFromFinalizeTxFailureArgs): Promise<never> {
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
