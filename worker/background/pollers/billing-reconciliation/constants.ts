// worker/background/pollers/billing-reconciliation/constants.ts
//
// Shared log namespace for the Stripe locations reconciliation subsystem.
// Single owner so the poller orchestrator, drift-alert sink, and per-account
// reconcile step all emit under the same prefix.

export const LOG_PREFIX = '[StripeLocationsReconcilePoller]';
