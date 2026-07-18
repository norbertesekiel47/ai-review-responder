// worker/background/pollers/billing-reconciliation/constants.ts
//
// Shared log namespace for the Stripe locations reconciliation subsystem.
// Single owner so the poller orchestrator, drift-alert sink, and per-account
// reconcile step all emit under the same prefix.

export const LOG_PREFIX = '[StripeLocationsReconcilePoller]';

// poller_cursors.poller_name for StripeLocationsReconcilePoller's durable keyset
// resume cursor (migration 079). One authoritative row key for load + save.
export const POLLER_NAME = 'stripe_locations_reconcile';

// Hard deadline on the single cursor persist in runOnce's finally. withTimeout
// does NOT cancel, so a save that outruns this bound keeps running detached and
// is rejected at the DB by the write-sequence CAS (ADR 0006) if a later save has
// already landed — the bound only stops it wedging inProgress (invariant #3).
export const CURSOR_SAVE_TIMEOUT_MS = 10_000;

// Hard deadline on the boot cursor load kicked from start(). Its own bound (the
// cycle deadline additionally bounds reconcileCycle's await of it) so a load
// that parks on pool acquisition before the first tick cannot hold a connection
// forever.
export const CURSOR_LOAD_TIMEOUT_MS = 10_000;
