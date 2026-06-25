// HealthAlertPoller — beta-launch gate (plan A). A time-cadence loop that runs
// read-only health checks for SILENT pipeline failures / dropped paid work and
// pages via the non-email Sentry route. The owner-approval requirement (auto-
// approval stays OFF for beta) is the content-safety control; this probe covers
// the failures that do NOT throw and so are invisible to per-incident captures:
// stuck/failed outbox by topic, zero-delivery approval notifications, stale
// dispatching (watchdog down), and the held-flag backlog. Each cycle also emits
// a Sentry Cron check-in so the probe's own death is detected (dead-man switch).
import { createWorkerLogger, logUnhandledPollError, toError } from '../../../src/lib/shared/logger';
import { notePollerActivity, maybeLogPollerHeartbeat } from '../poller-heartbeat';
import { runHealthChecks } from './health-alert/checks';
import { emitHealthFindings, recordProbeCheckIn } from './health-alert/emit';

const LOG_PREFIX = '[HealthAlertPoller]';
const POLL_INTERVAL_MS = parseInt(process.env.HEALTH_ALERT_POLL_INTERVAL_MS || '300000', 10);

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

export async function pollHealthAlerts(): Promise<void> {
  if (isPolling) return; // single-flight: a slow cycle must not overlap the next tick
  isPolling = true;
  const logger = createWorkerLogger(LOG_PREFIX);
  try {
    const findings = await runHealthChecks();
    if (findings.length > 0) {
      emitHealthFindings(findings);
      notePollerActivity(LOG_PREFIX);
      logger.error('Health alert findings', { count: findings.length, keys: findings.map((f) => f.key) });
    } else {
      maybeLogPollerHeartbeat(logger, LOG_PREFIX);
    }
    // The probe completed a cycle — check in to the Sentry Cron monitor so a
    // missed check-in (probe/worker dead) pages. Independent of findings.
    recordProbeCheckIn('ok', POLL_INTERVAL_MS);
  } catch (err) {
    logger.error('Health alert poll cycle failed', toError(err));
    recordProbeCheckIn('error', POLL_INTERVAL_MS);
  } finally {
    isPolling = false;
  }
}

export function startHealthAlertPoller(): void {
  const logger = createWorkerLogger(LOG_PREFIX);
  logger.log('Starting', { interval_ms: POLL_INTERVAL_MS });
  pollHealthAlerts().catch(logUnhandledPollError(LOG_PREFIX));
  pollerInterval = setInterval(() => {
    pollHealthAlerts().catch(logUnhandledPollError(LOG_PREFIX));
  }, POLL_INTERVAL_MS);
}

export function stopHealthAlertPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    createWorkerLogger(LOG_PREFIX).log('Stopped');
  }
}
