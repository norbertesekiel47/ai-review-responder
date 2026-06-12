// worker/background/pollers/billing-reconciliation/drift-alert.ts
//
// Drift alert sink: emits a Sentry warning when SENTRY_DSN is set, otherwise
// falls back to a warn-level structured log line. Owns the DriftAlertPayload
// shape produced by reconcileAccount and consumed by the poller orchestrator.

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

/**
 * Emits a drift alert. Uses Sentry when SENTRY_DSN is set,
 * falls back to a warn-level structured log line otherwise.
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

  if (process.env.SENTRY_DSN) {
    Sentry.captureMessage(message, {
      level: 'warning',
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
    logger.warn('Stripe billing drift detected', {
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
    });
  }
}
