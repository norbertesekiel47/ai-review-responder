// worker/background/pollers/billing-reconciliation/drift-alert.ts
//
// Drift alert sink: emits a Sentry event when SENTRY_DSN is set, otherwise
// falls back to a structured log line. Owns the DriftAlertPayload shape
// produced by reconcileAccount and consumed by the poller orchestrator.
//
// CONFIG-1: revenue-affecting drift must page, benign/observability drift stays
// at warning. The single configured Sentry rule today routes on "high priority"
// (warning-level captureMessage does not reliably qualify), so revenue-affecting
// drift is emitted at `error` to reach that classification + any error route.
// (Residual ops gap: no Discord rule yet routes feature:stripe_reconciliation —
// tracked in docs/runbooks/beta-launch-alerting.md.)

import { Sentry } from '../../../sentry';
import { createWorkerLogger } from '../../../../src/lib/shared/logger';
import { LOG_PREFIX } from './constants';
import type { DriftFinding } from './types';

const logger = createWorkerLogger(LOG_PREFIX);

export interface DriftAlertPayload {
  driftType?: DriftFinding['type'];
  dbExpectedOverage: number;
  stripeOverageQuantity: number;
  activeLocations: number;
  locationsIncluded: number;
  tier: string;
  isPilot?: boolean;
  expectedCents?: number;
  actualCents?: number;
  dbStatus?: string;
  stripeStatus?: string;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string | null;
  driftMessage?: string;
}

// Drift types that are observability signals only — no direct revenue impact.
// Everything NOT in this set is treated as revenue-affecting → paged at error.
// Fail-safe: any future/unknown type defaults to error rather than silently
// staying at warning.
const BENIGN_DRIFT_TYPES: ReadonlySet<NonNullable<DriftAlertPayload['driftType']>> = new Set([
  'status_mismatch',
  'locations_paid_mirror',
] satisfies Array<DriftFinding['type']>);

function driftAlertLevel(driftType: DriftAlertPayload['driftType']): 'error' | 'warning' {
  return driftType !== undefined && BENIGN_DRIFT_TYPES.has(driftType) ? 'warning' : 'error';
}

/**
 * Emits a drift alert. Uses Sentry when SENTRY_DSN is set, falls back to a
 * structured log line otherwise.
 *
 * Level is determined by drift type (CONFIG-1): revenue-affecting drifts emit
 * at `error` so they reach Sentry's high-priority classification; benign /
 * observability drifts (`status_mismatch`, `locations_paid_mirror`) stay at
 * `warning`. Unknown/future types fail safe to `error`.
 */
export function emitDriftAlert(
  accountId: string,
  payload: DriftAlertPayload,
): void {
  const message = payload.driftMessage ??
    `Stripe location drift detected for account ${accountId}: ` +
    `expected_overage=${payload.dbExpectedOverage} (from DB: ${payload.activeLocations} active - ${payload.locationsIncluded} included), ` +
    `stripe_overage=${payload.stripeOverageQuantity}, ` +
    `tier=${payload.tier}`;

  const level = driftAlertLevel(payload.driftType);

  if (process.env.SENTRY_DSN) {
    Sentry.captureMessage(message, {
      level,
      tags: {
        feature: 'stripe_reconciliation',
        account_id: accountId,
        drift_type: payload.driftType ?? 'quantity_mismatch',
        is_pilot: String(payload.isPilot === true),
      },
      extra: {
        accountId,
        driftMessage: payload.driftMessage,
        dbExpectedOverage: payload.dbExpectedOverage,
        stripeOverageQuantity: payload.stripeOverageQuantity,
        activeLocations: payload.activeLocations,
        locationsIncluded: payload.locationsIncluded,
        tier: payload.tier,
        isPilot: payload.isPilot === true,
        expectedCents: payload.expectedCents,
        actualCents: payload.actualCents,
        dbStatus: payload.dbStatus,
        stripeStatus: payload.stripeStatus,
        stripeSubscriptionId: payload.stripeSubscriptionId,
        stripeCustomerId: payload.stripeCustomerId,
      },
    });
  } else {
    const logFields = {
      account_id: accountId,
      drift_type: payload.driftType ?? 'quantity_mismatch',
      drift_message: message,
      db_expected_overage: payload.dbExpectedOverage,
      stripe_overage_quantity: payload.stripeOverageQuantity,
      active_locations: payload.activeLocations,
      locations_included: payload.locationsIncluded,
      tier: payload.tier,
      is_pilot: payload.isPilot === true,
      expected_cents: payload.expectedCents,
      actual_cents: payload.actualCents,
      db_status: payload.dbStatus,
      stripe_status: payload.stripeStatus,
      stripe_subscription_id: payload.stripeSubscriptionId,
      stripe_customer_id: payload.stripeCustomerId,
    };
    if (level === 'error') {
      logger.error('Stripe billing drift detected', logFields);
    } else {
      logger.warn('Stripe billing drift detected', logFields);
    }
  }
}
