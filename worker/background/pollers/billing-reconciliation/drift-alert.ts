// worker/background/pollers/billing-reconciliation/drift-alert.ts
//
// Drift alert sink: emits a Sentry warning when SENTRY_DSN is set, otherwise
// falls back to console.warn. Owns the DriftAlertPayload shape produced by
// reconcileAccount and consumed by the poller orchestrator.

import { Sentry } from '../../../sentry';
import { LOG_PREFIX } from './constants';
import type { DriftFinding } from './types';

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
 * falls back to console.warn otherwise.
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
    console.warn(`${LOG_PREFIX} ${message}`);
  }
}
