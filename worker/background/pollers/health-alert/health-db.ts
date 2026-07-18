// Dedicated postgres.js client lifecycle for the HealthAlertPoller — a bulkhead
// (#500) so a wedged health-check connection (server-side `state=active,
// wait_event=ClientRead` socket stall) can only starve THIS client's tiny pool,
// never the shared `sql` singleton the other ~20 loops depend on. `withTimeout`
// bounds the wait but does NOT cancel the wedged query, so its connection never
// returns to the pool; isolating the poller onto its own client contains the leak.
//
// On `withTimeout` expiry the poller calls `recycleHealthSql`, which end+rebuilds
// this client: the client-side FIN gives the wedged backend an EOF (plausible but
// not guaranteed — hence the PoolWedgeReaperPoller server-side backstop, which is
// why the health-check queries carry the `/* rw-reapable */` marker).
//
// Per invariant #15 this helper does NOT import the db/server factory: it holds
// the module-level client + reclaim semantics and receives a `buildClient`
// builder from its ONLY caller, the registered composition-root HealthAlertPoller
// (which owns the factory import + the DATABASE_POOL_URL/max choice). Mirrors the
// reaper's client lifecycle (buildReaperClient / recycleReaperClient /
// closeReaperClient), but keeps the factory in the root rather than a helper.
import type postgres from 'postgres';
import type { WorkerLogger } from '../../../../src/lib/shared/logger';
import { toError } from '../../../../src/lib/shared/logger';
import { withTimeout } from '../../../../src/lib/shared/with-timeout';

type HealthClient = postgres.Sql;

/** Builds a fresh dedicated health client. Injected by the composition root so
 *  the db/server factory + config stay there (invariant #15); this module owns
 *  only the singleton state and reclaim behavior. */
export type BuildHealthClient = () => HealthClient;

let healthSql: HealthClient | null = null;

/** The module-held dedicated health client, built lazily on first use. */
export function getHealthSql(buildClient: BuildHealthClient): HealthClient {
  if (!healthSql) healthSql = buildClient();
  return healthSql;
}

/**
 * Reclaim a wedged health connection: end the current client and rebuild a fresh
 * one so the next `getHealthSql()` returns working connections. The rebuild is
 * UNCONDITIONAL — even if `end()` hangs (bounded here by `withTimeout`) or
 * rejects — because a wedged client's `.end()` may never resolve, and the whole
 * point is that the next cycle runs on a clean client. `withTimeout` does not
 * cancel the detached `end()`; its client-side FIN is already on the wire, which
 * is what (plausibly) unwedges the server backend.
 */
export async function recycleHealthSql(
  buildClient: BuildHealthClient,
  logger: WorkerLogger,
): Promise<void> {
  const old = healthSql;
  try {
    if (old) await withTimeout(old.end({ timeout: 1 }), 2_000, 'health-client-end');
  } catch (err) {
    logger.warn('Health client end during recycle failed (rebuilt anyway)', toError(err));
  } finally {
    healthSql = buildClient();
  }
}

/**
 * End the dedicated health client WITHOUT rebuilding — for worker shutdown. A
 * later integration task awaits this inside worker/index.ts's `closeDb` step
 * alongside the shared `sql.end()` and the reaper's `closeReaperClient()`.
 * Best-effort: a failing end must not block shutdown.
 */
export async function closeHealthSql(): Promise<void> {
  const client = healthSql;
  healthSql = null;
  if (!client) return;
  try {
    await client.end({ timeout: 5 });
  } catch {
    // best-effort — shutdown proceeds regardless
  }
}
