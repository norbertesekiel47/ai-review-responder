// HealthAlertPoller — beta-launch gate (plan A). A time-cadence loop that runs
// read-only health checks for SILENT pipeline failures / dropped paid work and
// pages via the non-email Sentry route. The owner-approval requirement (auto-
// approval stays OFF for beta) is the content-safety control; this probe covers
// the failures that do NOT throw and so are invisible to per-incident captures:
// stuck/failed outbox by topic, zero-delivery approval notifications, stale
// dispatching (watchdog down), and the held-flag backlog. Each cycle also emits
// a Sentry Cron check-in so the probe's own death is detected (dead-man switch).
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql } from '../../../src/lib/db/server';
import { createWorkerLogger, logUnhandledPollError, toError } from '../../../src/lib/shared/logger';
import { withTimeout } from '../../../src/lib/shared/with-timeout';
import { notePollerActivity, maybeLogPollerHeartbeat } from '../poller-heartbeat';
import { runHealthChecks } from './health-alert/checks';
import { emitHealthFindings, recordProbeCheckIn } from './health-alert/emit';

const LOG_PREFIX = '[HealthAlertPoller]';

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
    const findings = await withTimeout(
      runHealthChecks(sql),
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
