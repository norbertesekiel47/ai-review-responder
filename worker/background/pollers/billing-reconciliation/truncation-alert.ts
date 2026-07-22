// worker/background/pollers/billing-reconciliation/truncation-alert.ts
//
// Sustained-truncation alert sink (ADR 0006, #479). Mirrors drift-alert.ts:
// emits a Sentry event when SENTRY_DSN is set, otherwise falls back to a
// structured log line. Owns the shape of the sustained-truncation signal —
// StripeLocationsReconcilePoller.runOnce fires it once when the reconcile sweep
// has been deadline-truncated for TRUNCATION_ALERT_THRESHOLD consecutive cycles
// with no full drain in between.
//
// Level is `warning` (not `error`): truncation is an operational-capacity signal
// — the sweep is falling behind its CYCLE_TIMEOUT budget — not a billing anomaly.
// It self-heals each cycle via the keyset cursor; sustained truncation means the
// account set has outgrown one cycle and needs a cadence/concurrency look.
// (Residual ops gap shared with drift-alert.ts: no Discord rule yet routes
// feature:stripe_reconciliation — tracked in docs/runbooks/beta-launch-alerting.md.)

import { Sentry } from '../../../sentry';
import { getWorkerConfig } from '../../../../src/lib/config/worker';
import { createWorkerLogger } from '../../../../src/lib/shared/logger';
import { LOG_PREFIX } from './constants';

const logger = createWorkerLogger(LOG_PREFIX);

export interface TruncationAlertInput {
  pollerName: string;
  consecutive: number;
  dispatched: number;
  total: number;
  cycleDeadlineMs: number;
}

/**
 * Emit the sustained-truncation alert. Uses Sentry when SENTRY_DSN is set, falls
 * back to a warn-level structured log line otherwise. Always `warning` level.
 *
 * Best-effort: the sole caller (runOnce.finally) invokes this inside a guard so a
 * sink failure can never block the cursor persist or wedge the single-flight
 * flag — this emitter is not on any state-mutating path.
 */
export function emitTruncationAlert(input: TruncationAlertInput): void {
  const { pollerName, consecutive, dispatched, total, cycleDeadlineMs } = input;
  const message =
    `Sustained reconcile truncation for ${pollerName}: ` +
    `${consecutive} consecutive cycles hit the ${cycleDeadlineMs}ms deadline ` +
    `before draining (last cycle claimed ${dispatched}/${total} accounts)`;

  if (getWorkerConfig().SENTRY_DSN) {
    Sentry.captureMessage(message, {
      level: 'warning',
      tags: {
        feature: 'stripe_reconciliation',
        poller: pollerName,
        alert: 'sustained_truncation',
      },
      extra: {
        pollerName,
        consecutiveTruncations: consecutive,
        dispatched,
        total,
        cycleDeadlineMs,
      },
    });
  } else {
    logger.warn('Sustained reconcile truncation', {
      poller: pollerName,
      consecutive_truncations: consecutive,
      dispatched,
      total,
      cycle_deadline_ms: cycleDeadlineMs,
    });
  }
}
