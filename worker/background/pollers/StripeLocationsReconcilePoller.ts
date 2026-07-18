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
//   - Only checks accounts with subscription_status = 'active', 'past_due', or 'trialing'
//   - Accepts accounts with no overage item when expected overage is zero
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
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { stripeLocationsReconcileDisabled } from '../../../src/lib/payments/flags';
import { sql } from '../../../src/lib/db/server';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { emitDriftAlert } from './billing-reconciliation/drift-alert';
import { emitTruncationAlert } from './billing-reconciliation/truncation-alert';
import { reconcileAccount } from './billing-reconciliation/reconcile-account';
import {
  LOG_PREFIX,
  POLLER_NAME,
  CURSOR_SAVE_TIMEOUT_MS,
  CURSOR_LOAD_TIMEOUT_MS,
  TRUNCATION_ALERT_THRESHOLD,
} from './billing-reconciliation/constants';
import { loadCursor, saveCursor } from './billing-reconciliation/cursor-store';
import {
  nextCursor,
  classifyCycle,
  evaluateTruncation,
  type ReconcileProgress,
  type CycleOutcome,
} from './billing-reconciliation/reconcile-progress';
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
// Bounded fan-out across accounts. Each account's work is one Stripe
// retrieve (+ occasional corrective calls) + a couple of DB reads —
// 3 concurrent accounts keeps well inside Stripe's rate limits and the
// shared Postgres pool while cutting the cycle wall-clock ~3×.
const ACCOUNT_FAN_OUT_CONCURRENCY = 3;
const logger = createWorkerLogger(LOG_PREFIX);

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
// Single-flight guard. Same pattern as EmailChannelReconcilePoller —
// prevents two scheduled ticks from running concurrently.
let inProgress = false;

// Keyset resume cursor (same pattern as ZernioRecentReviewPoller): the id of
// the last account whose reconcile was CLAIMED in the previous cycle — NOT
// necessarily fully reconciled, since each per-account reconcile is itself
// withTimeout-bounded (non-cancelling), so a claimed-but-timed-out account is
// attempted, not guaranteed processed. When a cycle hits its 240s deadline
// mid-list, the next cycle resumes after this id instead of re-walking the same
// head — without it, the same late-sorting accounts were never reconciled once
// the list outgrew the deadline.
//
// Persisted across restarts via poller_cursors (migration 079, ADR 0006). The
// never-skip invariant is preserved WITHOUT requiring "fully processed": on
// restart we resume AFTER the persisted id (accounts <= it were claimed this
// rotation); a claimed-but-timed-out account is simply re-checked on the NEXT
// rotation — drift detection defers at most one rotation, never permanently
// skips (drift is durable + idempotent to re-check). Ordering across saves is
// provable via the write_seq CAS, not by inProgress serialization (withTimeout
// does not cancel — a timed-out save can land late).
let accountCursor: string | null = null;

// In-memory write sequence for the cursor CAS (ADR 0006). Seeded at boot from
// the persisted write_seq so the first post-restart save is never rejected as
// stale; bumped synchronously (submission order) before each save.
//
// CORRECTNESS SCOPE: the CAS proves ordering for a SINGLE writer (the
// single-replica worker posture — one instance of this poller, serialized with
// update_stripe_overage per map #474). A second replica would have its own
// in-memory writeSeq and could interleave saves the CAS cannot fence across
// processes — cross-process fencing (a claim frontier / owner token) must be
// revisited before this poller ever runs on more than one replica.
let writeSeq = 0;

// Whether `writeSeq` has been seeded from the durable `poller_cursors.write_seq`.
// A boot-load FAILURE leaves it false: `writeSeq` still reads its module default
// 0 while the store may already hold write_seq=N, so blindly saving seq 1,2,…
// would be CAS-rejected until the seq climbed past N — silently disabling
// persistence for the process. runOnce.finally re-seeds (a fresh loadCursor)
// before its first save when this is still false, so a valid save is never
// rejected against a durable seq the failed boot-load never observed.
let writeSeqSeeded = false;

// Consecutive deadline-truncated cycles with no full drain in between (ADR 0006,
// #479 sustained-truncation alert). Updated in runOnce.finally from the cycle
// classification: any non-truncated cycle (a drain OR a stall) resets it to 0 —
// "consecutive" is literal, so a stall breaks the streak too (FIX 2b) — and a
// truncation bumps it (clamped at TRUNCATION_ALERT_THRESHOLD). Emits ONE
// warning-level alert when it first reaches the threshold. NOT persisted — an
// operational-capacity signal that a fresh boot is welcome to re-observe from zero.
let consecutiveTruncations = 0;

// Resolves once the boot cursor load has settled (seeding accountCursor +
// writeSeq, or logging and defaulting to a top-of-rotation scan on failure).
// null until start() kicks the load; reconcileCycle awaits it — when present —
// inside the cycle deadline before reading accountCursor.
let cursorLoaded: Promise<void> | null = null;

// Kicks the durable cursor boot-load. Bounded by its OWN withTimeout so a load
// that parks on pool acquisition between start() and the first tick cannot hold
// a connection forever; reconcileCycle's await is additionally bounded by the
// cycle deadline (runOnce wraps reconcileCycle in withTimeout).
function beginCursorLoad(): void {
  cursorLoaded = withTimeout(loadCursor(sql, POLLER_NAME), CURSOR_LOAD_TIMEOUT_MS, 'cursor load')
    .then((loaded) => {
      accountCursor = loaded.cursor;
      writeSeq = loaded.writeSeq;
      writeSeqSeeded = true;
    })
    .catch((err) => {
      // Boot-load failed: start the rotation from the top, and mark writeSeq
      // UNSEEDED so runOnce.finally re-seeds it from the durable write_seq before
      // its first save (otherwise the module-default seq 0 would be CAS-rejected
      // against a store that already holds a higher seq — disabling persistence).
      logger.error('Cursor boot-load failed — starting rotation from the top', err);
      accountCursor = null;
      writeSeqSeeded = false;
    });
}

export function resetAccountCursorForTests(): void {
  accountCursor = null;
  writeSeq = 0;
  writeSeqSeeded = false;
  cursorLoaded = null;
}

export function resetTruncationStateForTests(): void {
  consecutiveTruncations = 0;
}

/**
 * Test-only: simulate a COMPLETED, successful boot-load (empty cursor, seeded
 * writeSeq) WITHOUT issuing a SELECT. Lets tests that drive `runOnce` directly
 * skip both the first-tick lazy boot-load (FIX 3) and the unseeded re-seed
 * (FIX 1a) so their mock-`sql` FIFO accounting matches the pre-persistence
 * behavior. Boot-load-specific tests reset back to null via
 * resetAccountCursorForTests() / beginCursorLoadForTests().
 */
export function simulateBootLoadedForTests(): void {
  cursorLoaded = Promise.resolve();
  writeSeqSeeded = true;
}

/**
 * Test-only: drive the boot cursor load directly (start() otherwise owns it, but
 * it also arms timers + env guards). Returns the load promise so tests can await
 * the seeding of accountCursor + writeSeq.
 */
export function beginCursorLoadForTests(): Promise<void> {
  beginCursorLoad();
  return cursorLoaded!;
}

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
  // Lazily kick the durable cursor boot-load on the FIRST tick — deferred out of
  // start() so the SELECT lands AFTER the boot connection storm (the first tick
  // fires at +INITIAL_RUN_DELAY_MS). reconcileCycle awaits `cursorLoaded` inside
  // the cycle deadline before reading the cursor.
  if (cursorLoaded === null) beginCursorLoad();
  const controller = new AbortController();
  // Per-cycle progress snapshot (ADR 0006). reconcileCycle mutates it in place;
  // runOnce.finally classifies the cycle from it (with the outcome below) for the
  // sustained-truncation alert — even a deadline-aborted cycle leaves behind
  // whatever it set before unwinding.
  const progress: ReconcileProgress = { queryCompleted: false, total: 0, dispatched: 0 };
  // The cycle outcome, threaded into classifyCycle so a NON-timeout throw is not
  // mistaken for a demand-driven truncation (FIX 2a). 'ok' = reconcileCycle
  // returned; set to 'timeout'/'error' in catch.
  let outcome: CycleOutcome = 'ok';

  try {
    return await withTimeout(reconcileCycle(controller.signal, progress), CYCLE_TIMEOUT_MS, 'reconcile cycle');
  } catch (err) {
    // The detached cycle promise may still settle later. Abort so it stops
    // launching NEW per-account work (the in-flight account finishes under its
    // own bounded Stripe timeout, then the cycle unwinds and frees its pool
    // connection). Stripe SDK v22 has no request AbortSignal, so we cannot cancel
    // the in-flight HTTP call — the per-request timeout (reconcile-account.ts)
    // bounds it instead. Bounds a detached cycle to <=1 in-flight account.
    controller.abort();
    outcome = err instanceof TimeoutError ? 'timeout' : 'error';
    logger.error(
      outcome === 'timeout'
        ? 'Reconcile cycle exceeded its deadline — releasing the run so the next tick proceeds'
        : 'Reconcile cycle failed — releasing the run so the next tick proceeds',
      err,
    );
    return { accountsChecked: 0, driftsFound: 0, errors: 1 };
  } finally {
    // Sustained-truncation classification + alert (ADR 0006, #479). BEST-EFFORT
    // and fully guarded: it runs BEFORE the cursor persist and must never throw
    // out of finally nor block the persist / inProgress release (invariant #3).
    // Reads the progress snapshot (mutated by reconcileCycle, even on the aborted
    // path): any non-truncated cycle (a drain OR a stall) resets the counter, a
    // truncation bumps it and fires ONE alert on the first crossing to the threshold.
    try {
      const cycle = classifyCycle(progress, outcome);
      const evaluated = evaluateTruncation(consecutiveTruncations, cycle, TRUNCATION_ALERT_THRESHOLD);
      consecutiveTruncations = evaluated.consecutive;
      if (evaluated.alert) {
        emitTruncationAlert({
          pollerName: POLLER_NAME,
          consecutive: evaluated.consecutive,
          dispatched: progress.dispatched,
          total: progress.total,
          cycleDeadlineMs: CYCLE_TIMEOUT_MS,
        });
      }
    } catch (classifyErr) {
      logger.error('Truncation classification/alert failed — continuing to cursor persist', classifyErr);
    }

    // Single serialized cursor persist (ADR 0006). Assign the seq SYNCHRONOUSLY
    // (submission order) BEFORE awaiting, so the write_seq CAS rejects any
    // stale/detached/reordered save that lands later. The save is
    // withTimeout-bounded — a parked save can never wedge inProgress
    // (invariant #3) — and best-effort: a persist failure must not fail the run,
    // the next tick re-saves with a higher seq.
    //
    // FIX 1a: if the boot-load never seeded writeSeq (it failed), re-seed it from
    // the durable write_seq HERE before assigning the next seq — else the
    // module-default seq would be CAS-rejected against a higher stored seq,
    // silently disabling persistence for the whole process. If the re-seed ALSO
    // fails, skip the persist this cycle: the in-memory cursor still advanced, so
    // a restart re-walks the batch safely (never-skip, ADR 0006) and the next
    // tick retries the seed.
    //
    // The re-seed restores accountCursor from the durable frontier too, not just
    // writeSeq — and this is deliberate, not incidental. A failed boot-load left
    // accountCursor=null (top of rotation); on a truncated cycle this cycle's own
    // advance lands in the detached tail (the lag note below), so accountCursor
    // here is null/racy. Taking the durable cursor DETERMINISTICALLY recovers the
    // real rotation progress the failed boot-load never observed and keeps the
    // persisted value race-free w.r.t. that tail. Safe under never-skip either way:
    // a durable frontier only defers re-checks to the next rotation, it never
    // permanently skips (the head is re-checked when the rotation wraps).
    //
    // ADR 0006 lag note: on a deadline-truncated cycle the persisted cursor lags
    // the in-memory advance by one cycle, so a restart mid-truncation re-walks
    // that batch — bounded and safe per the never-skip invariant.
    let canPersist = true;
    if (!writeSeqSeeded) {
      try {
        const reseeded = await withTimeout(
          loadCursor(sql, POLLER_NAME),
          CURSOR_LOAD_TIMEOUT_MS,
          'cursor re-seed',
        );
        writeSeq = reseeded.writeSeq;
        accountCursor = reseeded.cursor;
        writeSeqSeeded = true;
      } catch (reseedErr) {
        canPersist = false;
        logger.error(
          'Cursor re-seed failed — skipping persist this cycle (in-memory cursor still advanced; restart re-walks safely)',
          reseedErr,
        );
      }
    }
    if (canPersist) {
      writeSeq += 1;
      const seq = writeSeq;
      await withTimeout(
        saveCursor(sql, POLLER_NAME, accountCursor, seq),
        CURSOR_SAVE_TIMEOUT_MS,
        'cursor save',
      ).catch((err) => logger.error('Cursor persist failed — will retry next tick', err));
    }
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
export async function reconcileCycle(
  signal: AbortSignal,
  progress: ReconcileProgress = { queryCompleted: false, total: 0, dispatched: 0 },
): Promise<ReconcileResult> {
  // Seed accountCursor + writeSeq from the durable boot load before reading the
  // cursor. Awaited INSIDE the cycle deadline (runOnce wraps this cycle in
  // withTimeout), so a never-settling load is released by the cycle timeout —
  // which frees inProgress — instead of wedging the poller. null when start()
  // has not kicked a load (e.g. tests driving reconcileCycle directly); then the
  // in-memory cursor is used as-is.
  if (cursorLoaded !== null) {
    await cursorLoaded;
  }

  // Fetch active paid accounts (resuming after the keyset cursor) and their
  // active location counts in a single query. ORDER BY a.id gives the stable
  // total order the cursor needs.
  const cursor = accountCursor;
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
      AND (${cursor}::uuid IS NULL OR a.id > ${cursor}::uuid)
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
    ORDER BY a.id ASC
  `;

  // The accounts query returned: the cycle got past the query, so a later
  // deadline classifies as truncated/drained (not stalled), and `total` records
  // the batch the fan-out must drain to count as a full drain.
  progress.queryCompleted = true;
  progress.total = accounts.length;

  if (accounts.length === 0) {
    if (cursor !== null) {
      // Reached the end of a resumed rotation — wrap to the top next cycle.
      accountCursor = null;
      logger.log('Rotation complete — cursor reset');
    } else {
      logger.log('No paid accounts to reconcile');
    }
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

  // Bounded fan-out (ZernioRecentReviewPoller pattern): a fixed pool of
  // workers pulls accounts in id order via a shared claim pointer. Once the
  // deadline aborts, no NEW account is claimed (in-flight ones finish under
  // their own ACCOUNT_TIMEOUT_MS). Counter mutation is safe — single-threaded
  // event loop, the fan-out interleaves awaits, not writes.
  let nextIndex = 0;
  const workerCount = Math.min(ACCOUNT_FAN_OUT_CONCURRENCY, accounts.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < accounts.length) {
        if (signal.aborted) return;
        const account = accounts[nextIndex]!;
        nextIndex += 1;
        progress.dispatched += 1;
        try {
          const outcome = await withTimeout(
            reconcileAccount(sql, stripe, account),
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
    }),
  );

  const dispatched = nextIndex;
  if (dispatched < accounts.length) {
    logger.log('Cycle aborted (deadline exceeded) — resuming after cursor next cycle', {
      dispatched,
      deferred: accounts.length - dispatched,
    });
  }

  // Cursor = last account actually claimed, so deferred accounts lead the next
  // cycle. A fully-drained list wraps to the start (this query has no LIMIT,
  // so draining the list means the rotation is complete). An abort before any
  // claim leaves the cursor untouched.
  if (dispatched > 0) {
    accountCursor = nextCursor(dispatched, accounts);
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
  if (stripeLocationsReconcileDisabled()) {
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

  // Worker-only poller → worker lane. The call site owns its own `envInterval ?
  // parseInt : NaN` + `Number.isFinite && >0 ? : DEFAULT` parse/default, so the
  // rawOptionalVar read preserves the byte-for-byte behavior of the old raw read.
  const envInterval = getWorkerConfig().STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS;
  const parsed = envInterval ? parseInt(envInterval, 10) : NaN;
  const interval =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;

  // The durable cursor boot-load is NOT kicked here (FIX 3): issuing its SELECT
  // in start() lands it inside the boot connection storm that INITIAL_RUN_DELAY_MS
  // exists to dodge. runOnce lazily kicks it on the first tick instead, so the
  // load fires post-storm at +INITIAL_RUN_DELAY_MS.
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
