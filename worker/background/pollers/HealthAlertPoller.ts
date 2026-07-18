// HealthAlertPoller — beta-launch gate (plan A). A time-cadence loop that runs
// read-only health checks for SILENT pipeline failures / dropped paid work and
// pages via the non-email Sentry route. The owner-approval requirement (auto-
// approval stays OFF for beta) is the content-safety control; this probe covers
// the failures that do NOT throw and so are invisible to per-incident captures:
// stuck/failed outbox by topic, zero-delivery approval notifications, stale
// dispatching (watchdog down), and the held-flag backlog. Each cycle also emits
// a Sentry Cron check-in so the probe's own death is detected (dead-man switch).
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { createDedicatedPostgresClient } from '../../../src/lib/db/server';
import { createWorkerLogger, logUnhandledPollError, toError } from '../../../src/lib/shared/logger';
import { TimeoutError, withTimeout } from '../../../src/lib/shared/with-timeout';
import { notePollerActivity, maybeLogPollerHeartbeat } from '../poller-heartbeat';
import { runHealthChecks } from './health-alert/checks';
import { getHealthSql, recycleHealthSql } from './health-alert/health-db';
import { emitHealthFindings, recordProbeCheckIn } from './health-alert/emit';

const LOG_PREFIX = '[HealthAlertPoller]';

// This composition root owns the db/server factory import + the client's config
// (invariant #15) and injects the builder into the health-db lifecycle helper.
// Points at DATABASE_POOL_URL — the SAME pooled route the checks ran against when
// they used the shared singleton — so only the pool is isolated, not semantics.
// max:2: five checks per single-flight cycle need no more.
/**
 * The queue-health endpoint's backlog count runs on the SAME bulkhead client as
 * the poller's checks, so the shared pool is never exposed to the #500 wedge
 * class from an externally-triggered request (PR #501 review finding F2).
 */
export function healthBulkheadSql(): ReturnType<typeof getHealthSql> {
  return getHealthSql(buildHealthClient);
}

function buildHealthClient(): ReturnType<typeof createDedicatedPostgresClient> {
  return createDedicatedPostgresClient(getWorkerConfig().DATABASE_POOL_URL, { max: 2 });
}

// A hung health-check query (e.g. a stale pooled connection where server-side
// statement_timeout never fires) must not wedge the single-flight poller: without
// a client-side bound, `runHealthChecks` hangs forever, `isPolling` stays true,
// every later tick is skipped, and the probe stops checking in AND stops
// detecting failures. On timeout the cycle falls to the catch (logs + 'error'
// check-in + resets isPolling), so the next tick runs.
const HEALTH_CHECK_TIMEOUT_MS = 30_000;

// Read at runtime (NOT module top level — convention #4: never call
// getWorkerConfig() at import). Worker env is immutable after boot, so this
// returns the same value the old once-at-import const did; default preserved.
function readPollIntervalMs(): number {
  return parseInt(getWorkerConfig().HEALTH_ALERT_POLL_INTERVAL_MS || '300000', 10);
}

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

export async function pollHealthAlerts(): Promise<void> {
  if (isPolling) return; // single-flight: a slow cycle must not overlap the next tick
  isPolling = true;
  const logger = createWorkerLogger(LOG_PREFIX);
  const pollIntervalMs = readPollIntervalMs();
  try {
    // Run on the dedicated bulkhead client (#500), never the shared `sql`
    // singleton — a wedged health-check connection must not starve the ~20 other
    // loops. getHealthSql() lazily builds it and returns the fresh client after a
    // recycle.
    const findings = await withTimeout(
      runHealthChecks(getHealthSql(buildHealthClient)),
      HEALTH_CHECK_TIMEOUT_MS,
      'health-alert-checks',
    );
    if (findings.length > 0) {
      emitHealthFindings(findings);
      notePollerActivity(LOG_PREFIX);
      logger.error('Health alert findings', { count: findings.length, keys: findings.map((f) => f.key) });
    } else {
      maybeLogPollerHeartbeat(logger, LOG_PREFIX);
    }
    // The probe completed a cycle — check in to the Sentry Cron monitor so a
    // missed check-in (probe/worker dead) pages. Independent of findings.
    recordProbeCheckIn('ok', pollIntervalMs);
  } catch (err) {
    logger.error('Health alert poll cycle failed', toError(err));
    recordProbeCheckIn('error', pollIntervalMs);
    // On the client-side timeout the health-check connection is (likely) wedged
    // in active+ClientRead and will never return to the dedicated pool. End+
    // rebuild the client so the next cycle runs on fresh connections (reclaim at
    // source). Only the TimeoutError path recycles — an ordinary DB error does
    // not imply a wedged socket. recycleHealthSql never throws (log-swallow +
    // unconditional rebuild), so it cannot escape this catch.
    if (err instanceof TimeoutError) await recycleHealthSql(buildHealthClient, logger);
  } finally {
    isPolling = false;
  }
}

export function startHealthAlertPoller(): void {
  const logger = createWorkerLogger(LOG_PREFIX);
  const pollIntervalMs = readPollIntervalMs();
  logger.log('Starting', { interval_ms: pollIntervalMs });
  pollHealthAlerts().catch(logUnhandledPollError(LOG_PREFIX));
  pollerInterval = setInterval(() => {
    pollHealthAlerts().catch(logUnhandledPollError(LOG_PREFIX));
  }, pollIntervalMs);
}

export function stopHealthAlertPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    createWorkerLogger(LOG_PREFIX).log('Stopped');
  }
}
