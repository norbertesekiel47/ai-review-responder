// worker/background/pollers/StripeLocationsReconcilePoller.ts
//
// Hourly drift detection: compares actual non-archived location count
// against Stripe subscription_items[overage].quantity. Drift > 0
// emits Sentry alert (or a warn-level structured log when SENTRY_DSN unset).
//
// Does NOT auto-correct — manual investigation only.
//
// Scope conditions:
//   - Checks paid accounts whether stripe_subscription_id is present or missing
//   - Only checks accounts with subscription_status = 'active' or 'past_due'
//   - Skips accounts with no overage item in Stripe (basic tier, legacy)
//   - Uses the stored billing snapshot to determine expected overage/invoice totals
//
// Default cadence: every 60 minutes (3_600_000 ms).
// Override via STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS.
// Set STRIPE_LOCATIONS_RECONCILE_DISABLED=true to skip entirely
// (mock mode does too).
//
// Per-account reconciliation lives in billing-reconciliation/reconcile-account.ts;
// this file owns orchestration (query, single-flight, alert emission, tally) and
// the poller lifecycle.

import { getStripe } from '../../../src/lib/payments/stripe-client';
import { sql } from '../../../src/lib/db/server';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { emitDriftAlert } from './billing-reconciliation/drift-alert';
import { reconcileAccount } from './billing-reconciliation/reconcile-account';
import { LOG_PREFIX } from './billing-reconciliation/constants';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { withTimeout, TimeoutError } from '../../../src/lib/shared/with-timeout';
import type { AccountWithLocations } from './billing-reconciliation/types';

const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour

// Hard deadlines so a stuck run can NEVER wedge the poller. The Postgres.js
// pool-queue wait is unbounded: `connect_timeout` covers only opening a socket
// and `statement_timeout` only executing a query — NEITHER bounds waiting for a
// free slot when the worker's shared pool is exhausted (15+ pollers + BullMQ +
// webhook retries share `max: 10`). Without these, a run that parks on
// connection acquisition holds `inProgress=true` forever and every later tick
// skips — silently disabling the missed-webhook backstop (invariant #3 / PLAN
// §5). A timed-out run logs, releases `inProgress`, and the next tick retries.
const ACCOUNT_TIMEOUT_MS = 60_000; // one account's Stripe + DB work
const CYCLE_TIMEOUT_MS = 240_000; // the whole cycle (accounts query + all accounts)

// Delay the FIRST run past the boot-time connection storm. At startup every poller
// + BullMQ worker + ingress hits the shared Postgres pool (`max:10`) at once — a live
// probe showed `SELECT 1` on the shared pool stalling 15s+ at boot while a fresh
// client answered in 135ms, so the immediately-fired reconcile query queued behind it.
// The hourly cadence makes a 45s-late first run immaterial, and the boot storm has
// drained by then. (The cycle timeout above still covers any residual/under-load
// contention.)
const INITIAL_RUN_DELAY_MS = 45_000;
const logger = createWorkerLogger(LOG_PREFIX);

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
// Single-flight guard. Same pattern as EmailChannelReconcilePoller —
// prevents two scheduled ticks from running concurrently.
let inProgress = false;

interface ReconcileResult {
  accountsChecked: number;
  driftsFound: number;
  errors: number;
}

/**
 * Runs one reconciliation cycle under a hard deadline. Single-flight: a tick is
 * skipped while a previous run is still going. CRITICAL: the cycle is wrapped in
 * `withTimeout` so a stuck run (e.g. parked on Postgres pool acquisition) can
 * never hold `inProgress` forever and silently disable all future ticks — it
 * aborts, releases the flag, and the next tick retries.
 */
export async function runOnce(): Promise<ReconcileResult> {
  if (inProgress) {
    logger.log('Previous run still in progress — skipping this tick');
    return { accountsChecked: 0, driftsFound: 0, errors: 0 };
  }
  inProgress = true;
  const controller = new AbortController();

  try {
    return await withTimeout(reconcileCycle(controller.signal), CYCLE_TIMEOUT_MS, 'reconcile cycle');
  } catch (err) {
    // The detached cycle promise may still settle later. Abort so it stops
    // launching NEW per-account work (the in-flight account finishes under its
    // own bounded Stripe timeout, then the cycle unwinds and frees its pool
    // connection). Stripe SDK v22 has no request AbortSignal, so we cannot cancel
    // the in-flight HTTP call — the per-request timeout (reconcile-account.ts)
    // bounds it instead. Bounds a detached cycle to <=1 in-flight account.
    controller.abort();
    logger.error(
      err instanceof TimeoutError
        ? 'Reconcile cycle exceeded its deadline — releasing the run so the next tick proceeds'
        : 'Reconcile cycle failed — releasing the run so the next tick proceeds',
      err,
    );
    return { accountsChecked: 0, driftsFound: 0, errors: 1 };
  } finally {
    inProgress = false;
  }
}

/**
 * One reconciliation pass. For each active/past_due/trialing paid account,
 * compares the expected overage quantity (from DB) with Stripe and applies the
 * scoped trial correction. Each per-account reconcile is itself bounded so one
 * parked account cannot consume the whole cycle budget.
 *
 * Exported for direct unit testing of the abort-on-deadline contract: when
 * `signal` is aborted (runOnce's cycle deadline fired), the loop stops launching
 * NEW per-account work so a detached cycle cannot keep iterating all accounts and
 * starve the shared Postgres pool. The in-flight account (if any) still settles
 * under its own bounded Stripe timeout — Stripe SDK v22 has no request
 * AbortSignal, so this only halts the loop, it cannot cancel an open HTTP call.
 */
export async function reconcileCycle(signal: AbortSignal): Promise<ReconcileResult> {
  // Fetch all active paid accounts and their
  // active location counts in a single query.
  const accounts = await sql<AccountWithLocations[]>`
    SELECT
      a.id,
      a.subscription_tier,
      a.subscription_status,
      a.stripe_customer_id,
      a.stripe_subscription_id,
      a.locations_included,
      a.locations_paid,
      a.locations_overage_price_cents,
      a.base_price_cents,
      a.past_due_at,
      a.flags,
      COUNT(b.id) AS active_location_count
    FROM accounts a
    LEFT JOIN businesses b ON b.account_id = a.id AND b.archived_at IS NULL
    -- RECONCILE-F3: pending_payment is intentionally excluded. Missed activation
    -- is owned by StripeCheckoutReconcileWorker (worker/jobs/billing/), which
    -- re-retrieves the Checkout Session and re-runs processCheckoutSessionCompleted.
    -- This poller reconciles only entitled/billable states.
    WHERE a.subscription_status IN (${SubscriptionStatus.ACTIVE}, ${SubscriptionStatus.PAST_DUE}, ${SubscriptionStatus.TRIALING})
    GROUP BY
      a.id,
      a.subscription_tier,
      a.subscription_status,
      a.stripe_customer_id,
      a.stripe_subscription_id,
      a.locations_included,
      a.locations_paid,
      a.locations_overage_price_cents,
      a.base_price_cents,
      a.past_due_at,
      a.flags
  `;

  if (accounts.length === 0) {
    logger.log('No paid accounts to reconcile');
    return { accountsChecked: 0, driftsFound: 0, errors: 0 };
  }

  // Breadcrumb: proves the accounts query returned (vs parked on pool
  // acquisition). If a cycle later times out WITHOUT this line, the stall is the
  // query itself; WITH it, the per-account error logs pinpoint which account.
  logger.log(`Reconciling ${accounts.length} paid accounts`);

  const stripe = getStripe();

  let accountsChecked = 0;
  let driftsFound = 0;
  let errors = 0;

  for (const account of accounts) {
    if (signal.aborted) {
      logger.log('Cycle aborted (deadline exceeded) — stopping before remaining accounts');
      break;
    }
    try {
      const outcome = await withTimeout(
        reconcileAccount(stripe, account),
        ACCOUNT_TIMEOUT_MS,
        `reconcile account ${account.id}`,
      );
      accountsChecked += outcome.accountsChecked;
      errors += outcome.errors;
      for (const payload of outcome.drifts) {
        emitDriftAlert(account.id, payload);
        driftsFound++;
      }
    } catch (err) {
      errors++;
      logger.error(`Error reconciling account ${account.id}`, err);
    }
  }

  if (driftsFound > 0 || errors > 0) {
    logger.log(`Run complete: accountsChecked=${accountsChecked} driftsFound=${driftsFound} errors=${errors}`);
  } else {
    logger.log(`Run complete: ${accountsChecked} accounts checked, no drift detected`);
  }

  return { accountsChecked, driftsFound, errors };
}

/**
 * Starts the hourly reconciliation poller.
 */
export function startStripeLocationsReconcilePoller(): void {
  if (process.env.STRIPE_LOCATIONS_RECONCILE_DISABLED === 'true') {
    logger.log('STRIPE_LOCATIONS_RECONCILE_DISABLED=true — not starting');
    return;
  }
  if (process.env.MOCK_EXTERNAL_APIS === 'true') {
    logger.log('MOCK_EXTERNAL_APIS=true — not starting');
    return;
  }

  // Idempotent start
  if (timer !== null) {
    logger.log('Already started — ignoring duplicate startStripeLocationsReconcilePoller() call');
    return;
  }

  const envInterval = process.env.STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS;
  const parsed = envInterval ? parseInt(envInterval, 10) : NaN;
  const interval =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;

  logger.log(`Starting (interval=${interval}ms, initial delay=${INITIAL_RUN_DELAY_MS}ms)`);
  initialTimer = setTimeout(() => {
    initialTimer = null;
    runOnce().catch((err) => logger.error('Initial run failed', err));
  }, INITIAL_RUN_DELAY_MS);
  timer = setInterval(() => {
    runOnce().catch((err) => logger.error('Scheduled run failed', err));
  }, interval);
}

/**
 * Stops the reconciliation poller.
 */
export function stopStripeLocationsReconcilePoller(): void {
  if (initialTimer !== null) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
    logger.log('Stopped');
  }
  // Do NOT reset inProgress. If stop() fires mid-runOnce (graceful
  // shutdown), the in-flight run's finally{} clears the flag itself.
  // Same pattern as EmailChannelReconcilePoller.
}
