import { sql, supabaseServer } from '../../../src/lib/db/server';
import { createWorkerLogger } from '../../../src/lib/shared/logger';

const DEFAULT_INTERVAL_MS = 86_400_000; // 24 hours
const DEFAULT_BATCH_SIZE = 100;

let timer: ReturnType<typeof setInterval> | null = null;
// Single-flight guard. Prevents two scheduled ticks from running runOnce()
// concurrently when a run takes longer than the interval (e.g., the 60s
// test interval from Scenario H, OR a real 24h run that happens to land
// during a Supabase outage and stalls). Concurrent runs would: (a) race
// on the same candidate list selected outside any tx, (b) the second run
// would block on FOR UPDATE locks taken by the first, holding worker
// resources for nothing. Skip-this-tick is the right answer.
let inProgress = false;

/**
 * Delete self-serve signups that haven't paid within 7 days.
 *
 * Scope (SQL filter enforces these — never relax without auditing every caller):
 *   - subscription_status = 'pending_payment'
 *   - stripe_customer_id IS NULL            (Stripe checkout never completed)
 *   - onboarded_by IS NULL                  (self-serve; admin-created rows are untouched)
 *   - users.auth_id IS NOT NULL             (Supabase Auth user exists to clean up)
 *   - created_at < NOW() - INTERVAL '7 days'
 *
 * Safety layers:
 *   1. Per-owner advisory lock on hashtext(email + ':signup') — SAME KEY as signup
 *      + finish-signup routes. An owner re-signing up mid-cleanup will serialize
 *      behind us and see a clean state.
 *   2. Defensive refs check. users.business_id doesn't cascade from businesses,
 *      and onboarded_by / prospect_demos.created_by shouldn't be set for self-
 *      serve owners by construction — but we verify anyway. Finding a ref is a
 *      scope invariant violation, so we skip + log a warning instead of deleting.
 *   3. "User not found" = success. A prior cleanup may have deleted the Supabase
 *      Auth user but the DB tx failed; the next poll sees 404 and should proceed.
 */
export async function runOnce(): Promise<void> {
  const logger = createWorkerLogger('[CleanupAbandonedSignups]');
  // Single-flight: if a previous invocation is still executing, skip this
  // tick. The check + set is safe because the JS event loop is
  // single-threaded — no atomic-CAS needed. The finally below clears the
  // flag so a subsequent tick can run even if this one threw.
  if (inProgress) {
    logger.log('Previous run still in progress — skipping this tick');
    return;
  }
  inProgress = true;
  try {
    return await runOnceInner(logger);
  } finally {
    inProgress = false;
  }
}

async function runOnceInner(
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<void> {
  // Tier-2 housekeeping: drop completed onboarding demos older than 30 days.
  // CASCADE on user_id/business_id covers the abandoned-signup path; this
  // independent pass collects long-lived demo rows from successful signups
  // whose user/business are still active. Failures here MUST NOT block the
  // main cleanup loop — log and continue. Runs BEFORE the abandoned-signup
  // candidates SELECT so a flake here doesn't prevent the primary cleanup.
  try {
    const staleResult = await sql`
      DELETE FROM onboarding_demos
      WHERE generation_status = 'completed'
        AND completed_at < NOW() - INTERVAL '30 days'
    `;
    if (staleResult.count && staleResult.count > 0) {
      logger.log(`Deleted ${staleResult.count} stale completed onboarding demos`);
    }
  } catch (err) {
    logger.error(
      `Failed to cleanup stale onboarding demos: ${err instanceof Error ? err.message : err}`,
    );
  }

  const envVal = process.env.CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE;
  const parsedBatchSize = envVal ? parseInt(envVal, 10) : NaN;
  const batchSize = Number.isFinite(parsedBatchSize) && parsedBatchSize > 0
    ? parsedBatchSize
    : DEFAULT_BATCH_SIZE;

  const candidates = await sql<{
    business_id: string;
    user_id: string;
    owner_email: string;
    auth_id: string;
  }[]>`
    SELECT b.id AS business_id, u.id AS user_id, b.owner_email, u.auth_id
    FROM businesses b
    JOIN users u ON u.business_id = b.id AND u.role = 'owner'
    WHERE b.subscription_status = 'pending_payment'
      AND b.stripe_customer_id IS NULL
      AND b.onboarded_by IS NULL
      AND u.auth_id IS NOT NULL
      AND b.created_at < NOW() - INTERVAL '7 days'
    ORDER BY b.created_at ASC, b.id ASC
    LIMIT ${batchSize}
  `;

  let deleted = 0;
  let skippedRefs = 0;
  let supabaseFailed = 0;

  let skippedStateChanged = 0;

  for (const candidate of candidates) {
    try {
      await sql.begin(async (tx) => {
        // Take BOTH the per-email signup lock (serializes against signup +
        // finish-signup) AND the per-business activation lock (serializes
        // against the Stripe webhook). A TOCTOU between candidate selection
        // and this delete would let us nuke a paid customer if Stripe
        // activated the business within the same poll cycle. Acquire both
        // locks BEFORE re-reading state so any pending writer commits before
        // our re-read.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${candidate.owner_email + ':signup'}))`;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${candidate.business_id + ':activation'}))`;

        // Re-validate ALL cleanup predicates under the lock + FOR UPDATE.
        // The candidate list was fetched outside any transaction; if Stripe
        // flipped subscription_status between then and now, deleting would
        // destroy a paying customer's account. SELECT FOR UPDATE both rows
        // so concurrent writers block until we commit/rollback.
        const [biz] = await tx<{
          subscription_status: string;
          stripe_customer_id: string | null;
          onboarded_by: string | null;
          created_at: Date;
        }[]>`
          SELECT subscription_status, stripe_customer_id, onboarded_by, created_at
          FROM businesses
          WHERE id = ${candidate.business_id}::uuid
          FOR UPDATE
        `;
        const [usr] = await tx<{ auth_id: string | null; role: string }[]>`
          SELECT auth_id, role
          FROM users
          WHERE id = ${candidate.user_id}::uuid
          FOR UPDATE
        `;

        // Identity-binding check: usr.auth_id must STILL equal the candidate
        // auth_id we captured at SELECT time. Without this, a stale candidate
        // whose users row was re-linked to a NEW Supabase auth user (e.g.,
        // admin manually patched it) would let us call deleteUser(<old auth_id>)
        // and destroy the wrong identity. Belt-and-suspenders alongside the
        // role + IS NOT NULL checks.
        const stillEligible =
          biz != null &&
          usr != null &&
          biz.subscription_status === 'pending_payment' &&
          biz.stripe_customer_id === null &&
          biz.onboarded_by === null &&
          usr.role === 'owner' &&
          usr.auth_id !== null &&
          usr.auth_id === candidate.auth_id &&
          new Date(biz.created_at).getTime() <
            Date.now() - 7 * 24 * 60 * 60 * 1000;

        if (!stillEligible) {
          // Most common reason: Stripe activated the business between SELECT
          // and lock acquisition. Logging at info level — this is healthy
          // poller behavior, not a bug. Other reasons: someone manually
          // mutated state, or the row was already deleted by an earlier batch.
          logger.log(
            `Skipping ${candidate.business_id} — state changed since selection (status=${biz?.subscription_status ?? 'missing'} stripe_customer=${biz?.stripe_customer_id ?? 'null'} onboarded_by=${biz?.onboarded_by ?? 'null'})`,
          );
          skippedStateChanged++;
          return;
        }

        const [refs] = await tx<{
          has_onboarded: boolean;
          has_prospect_demos: boolean;
        }[]>`
          SELECT
            EXISTS (SELECT 1 FROM businesses WHERE onboarded_by = ${candidate.user_id}::uuid) AS has_onboarded,
            EXISTS (SELECT 1 FROM prospect_demos WHERE created_by = ${candidate.user_id}::uuid) AS has_prospect_demos
        `;

        if (refs && (refs.has_onboarded || refs.has_prospect_demos)) {
          logger.warn(
            `Skipping ${candidate.user_id} — referenced by other tables (invariant violation): has_onboarded=${refs.has_onboarded} has_prospect_demos=${refs.has_prospect_demos}`,
          );
          skippedRefs++;
          return;
        }

        // Race the Supabase admin call against a 10s timeout. The supabase-js
        // admin SDK doesn't expose AbortController hooks, so a hung server
        // would otherwise hold the advisory lock + FOR UPDATE row lock
        // indefinitely and block subsequent cleanup runs against the same
        // email. Promise.race rejects → outer catch logs + we move on.
        let deleteResult: Awaited<
          ReturnType<typeof supabaseServer.auth.admin.deleteUser>
        >;
        try {
          deleteResult = await Promise.race([
            supabaseServer.auth.admin.deleteUser(candidate.auth_id),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    Object.assign(new Error('Supabase deleteUser timeout'), {
                      code: 'TIMEOUT',
                    }),
                  ),
                10_000,
              ),
            ),
          ]);
        } catch (raceErr) {
          const errCode = (raceErr as { code?: string } | null)?.code;
          if (errCode === 'TIMEOUT') {
            logger.warn(
              `Supabase deleteUser timeout for ${candidate.auth_id} after 10s`,
            );
          }
          supabaseFailed++;
          throw raceErr; // rolls back tx
        }

        const { error } = deleteResult;
        // "User not found" means a prior cleanup deleted the Supabase user but
        // the DB tx didn't commit. Proceed with DB delete to finish the job.
        if (error && !/not[_ ]?found|404/i.test(error.message)) {
          logger.warn(
            `Supabase deleteUser failed for ${candidate.auth_id}: ${error.message}`,
          );
          supabaseFailed++;
          throw error;
        }

        // Explicit cleanup of onboarding_demos (FK CASCADE on user_id covers
        // the data — this is defense-in-depth so the row count is observable
        // in logs alongside the user/business deletions, and so a future
        // change to FK semantics doesn't silently leave orphan rows). Runs
        // ONLY after Supabase deleteUser succeeds; on supabase failure the
        // throw above rolls back the tx and this query never executes.
        await tx`DELETE FROM onboarding_demos WHERE user_id = ${candidate.user_id}::uuid`;

        // FK-aware ordering: users.business_id does NOT cascade from businesses,
        // so users MUST be deleted first. The DELETE predicate also pins
        // auth_id to the candidate's value — if the row got re-linked to a
        // different identity between our re-read and now (impossible under
        // the FOR UPDATE lock but defensive against future tx-level changes),
        // we'd want the DELETE to match 0 rows rather than nuke the wrong
        // user.
        await tx`
          DELETE FROM users
          WHERE id = ${candidate.user_id}::uuid
            AND auth_id = ${candidate.auth_id}
        `;
        await tx`DELETE FROM businesses WHERE id = ${candidate.business_id}::uuid`;
        deleted++;
      });
    } catch (err) {
      logger.error(
        `Cleanup tx failed for business ${candidate.business_id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  logger.log(
    `Run complete: candidates=${candidates.length} deleted=${deleted} skipped_state_changed=${skippedStateChanged} skipped_refs=${skippedRefs} supabase_failed=${supabaseFailed}`,
  );
}

export function startCleanupAbandonedSignupsPoller(): void {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    console.log(
      '[CleanupAbandonedSignups] SELF_SERVE_SIGNUP_ENABLED != true — not starting',
    );
    return;
  }

  // Idempotent start: if a timer is already registered, this is a duplicate
  // call (worker hot-reload, mistaken double-init in tests, etc.). Return
  // early instead of overwriting `timer` — overwriting leaks the previous
  // setInterval handle so stop() can never clear it.
  if (timer !== null) {
    console.log(
      '[CleanupAbandonedSignups] Already started — ignoring duplicate startCleanupAbandonedSignupsPoller() call',
    );
    return;
  }

  const envVal = process.env.CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS;
  const parsed = envVal ? parseInt(envVal, 10) : NaN;
  const interval = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;

  console.log(`[CleanupAbandonedSignups] Starting (interval=${interval}ms)`);
  runOnce().catch((err) =>
    console.error('[CleanupAbandonedSignups] Initial run failed:', err),
  );
  timer = setInterval(() => {
    runOnce().catch((err) =>
      console.error('[CleanupAbandonedSignups] Scheduled run failed:', err),
    );
  }, interval);
}

export function stopCleanupAbandonedSignupsPoller(): void {
  // `if (timer !== null)` — NOT `if (timer)`. setInterval returns
  // `Timeout` objects in production but tests mock it to return literal
  // values that may be falsy (e.g., 0). The truthy check would leave
  // `timer = 0` un-cleared, breaking the start() idempotency guard for
  // the next test (timer !== null is true, so start() bails).
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  // Do NOT reset inProgress here. If stop() fires while runOnce() is
  // mid-flight (e.g., graceful shutdown signal lands during a 24h tx),
  // the in-flight run's finally{} clears the flag itself when it
  // completes — racing it from stop() would let a fresh start()
  // schedule a tick that runs in PARALLEL with the still-executing
  // run, defeating the single-flight guarantee. The flag's only owner
  // is whoever set it (runOnce); stop() only owns the timer.
}
