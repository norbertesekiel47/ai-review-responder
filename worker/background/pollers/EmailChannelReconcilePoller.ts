import { sql } from '../../../src/lib/db/server';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { invalidateChannelCache } from '../../../src/lib/notifications/resolve-channels';
import { asAccountId } from '../../../src/lib/shared/ids';
import { v7 as uuidv7 } from 'uuid';

/**
 * Reconciliation safety net for the email `channel_enrollments` row.
 *
 * The inline INSERT in `/api/auth/verify-otp` and `/api/auth/finish-signup`
 * runs in a try/catch — if it throws (transient DB error, advisory-lock
 * timeout, etc.), the user-facing flow continues so the consumed OTP / Google
 * session isn't wasted. That's the right user experience, but it leaves the
 * business in a state where `NotificationWorker` finds 0 verified channels
 * and silently drops every approval email — exactly the B10 failure mode.
 *
 * This poller is the durable retry. It scans `active`-subscription owners
 * who lack a verified email enrollment and inserts one. Idempotent via a
 * select-then-insert transaction pattern inside `sql.begin()`: first SELECT
 * for an existing enrollment, then INSERT only if not found. Concurrent
 * INSERT races produce a 23505 unique violation which is caught and treated
 * as benign (same semantics as the old ON CONFLICT DO NOTHING).
 *
 * After migration 034, the candidate query joins via users.account_id and
 * reads subscription_status from accounts (not businesses). The INSERT
 * includes account_id to satisfy the NOT NULL constraint.
 *
 * Scope conditions (intentionally narrow — false positives turn unverified
 * emails into "verified" rows, which is worse than the bug we're patching):
 *   - businesses.subscription_status = 'active' (proven payment + completed
 *     OTP/Google-confirmed; for `pending_payment` rows the channel doesn't
 *     matter because the subscription guard skips notifications)
 *   - users.role = 'owner' (admins don't receive approval notifications)
 *   - users.auth_id IS NOT NULL (admin-onboarded rows that haven't run the
 *     post-B11 invite step yet are excluded — those need a different fix)
 *   - NO email row in channel_enrollments AT ALL — including archived rows.
 *     This distinguishes "never created" (the failure mode we want to
 *     repair) from "intentionally archived" (the admin/owner asked us to
 *     stop emailing them). Recreating an archived row would silently
 *     resubscribe an unsubscribed owner — the original B7 bug in reverse.
 *     The archived row's existence means human intent already decided this
 *     business; this poller respects that.
 *
 * Default cadence: every 10 minutes. Override via
 * `EMAIL_CHANNEL_RECONCILE_INTERVAL_MS`. Set
 * `EMAIL_CHANNEL_RECONCILE_DISABLED=true` to skip entirely (mock mode does too).
 */
const DEFAULT_INTERVAL_MS = 600_000; // 10 minutes
const DEFAULT_BATCH_SIZE = 100;
// Hard ceiling on how many candidates one tick processes. Without this, a
// misconfigured EMAIL_CHANNEL_RECONCILE_BATCH_SIZE=10000 would issue 10k
// serial INSERTs holding the worker on its sole runOnce slot for the whole
// interval and starving any subsequent tick (single-flight skips it). The
// poller is recovery-only — capping batch size keeps it well-behaved even
// under operator misconfiguration.
const MAX_BATCH_SIZE = 1_000;

let timer: ReturnType<typeof setInterval> | null = null;
// Single-flight guard. Same pattern as CleanupAbandonedSignupsPoller —
// prevents two scheduled ticks from running concurrently if a run takes
// longer than the interval (Postgres slowness, etc.).
let inProgress = false;

interface MissingChannelRow {
  business_id: string;
  account_id: string;
  owner_email: string;
}

export async function runOnce(): Promise<{
  candidates: number;
  inserted: number;
  failed: number;
}> {
  const logger = createWorkerLogger('[EmailChannelReconcile]');
  // Single-flight: if a previous invocation is still executing, skip this
  // tick and return zero-counts. The check + set is safe because the JS
  // event loop is single-threaded. The finally below clears the flag so
  // a subsequent tick can run even if this one threw.
  if (inProgress) {
    logger.log('Previous run still in progress — skipping this tick');
    return { candidates: 0, inserted: 0, failed: 0 };
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
): Promise<{
  candidates: number;
  inserted: number;
  failed: number;
}> {
  const envBatch = process.env.EMAIL_CHANNEL_RECONCILE_BATCH_SIZE;
  const parsedBatch = envBatch ? parseInt(envBatch, 10) : NaN;
  const requestedBatchSize =
    Number.isFinite(parsedBatch) && parsedBatch > 0
      ? parsedBatch
      : DEFAULT_BATCH_SIZE;
  const batchSize = Math.min(requestedBatchSize, MAX_BATCH_SIZE);

  const candidates = await sql<MissingChannelRow[]>`
    SELECT b.id AS business_id, b.account_id, b.owner_email
    FROM businesses b
    JOIN users u ON u.account_id = b.account_id AND u.role = 'owner'
    JOIN accounts a ON a.id = b.account_id
    WHERE a.subscription_status = 'active'
      AND u.auth_id IS NOT NULL
      AND b.owner_email IS NOT NULL
      AND NOT EXISTS (
        -- Note: NO archived_at filter here. We want to repair only
        -- "never had an email channel" rows. Archived rows mean the
        -- owner/admin explicitly removed the enrollment — recreating
        -- it as 'verified' would silently resubscribe an unsubscribed
        -- recipient (the original B7 bug in reverse).
        SELECT 1 FROM channel_enrollments ce
        WHERE ce.business_id = b.id
          AND ce.channel = 'email'
      )
    LIMIT ${batchSize}
  `;

  let inserted = 0;
  let failed = 0;

  for (const row of candidates) {
    try {
      // Use sql.begin() for a select-then-insert transaction pattern.
      // The old ON CONFLICT (business_id, channel) WHERE archived_at IS NULL
      // targeted the dropped channel_enrollments_business_channel_active_key
      // index. Postgres cannot target expression-based unique indexes (which
      // use COALESCE) with ON CONFLICT, so we use a transaction instead:
      // first SELECT for an existing enrollment, then INSERT only if not found.
      // The transaction serializes the check+insert so that a concurrent
      // writer inserting the same row will either be visible to our SELECT
      // (and we skip) or will conflict on the unique index (and we catch
      // the 23505 as a benign race, same as the old ON CONFLICT DO NOTHING).
      const wasInserted = await sql.begin(async (tx) => {
        const existing = await tx<{ id: string }[]>`
          SELECT id FROM channel_enrollments
          WHERE business_id = ${row.business_id}
            AND channel = 'email'
            AND archived_at IS NULL
        `;
        if (existing.length > 0) {
          // Another writer (verify-otp, concurrent reconcile) already created
          // an active email enrollment — skip. This is the same semantics as
          // the old ON CONFLICT DO NOTHING.
          return false;
        }
        await tx`
          INSERT INTO channel_enrollments (id, account_id, business_id, channel, handle, status, verified_at)
          VALUES (${uuidv7()}, ${row.account_id}, ${row.business_id}, 'email', ${row.owner_email}, 'verified', NOW())
        `;
        return true;
      });
      if (wasInserted) {
        inserted++;
        // VAL-NOTIF-009: Invalidate cache on channel_enrollments writes
        try {
          await invalidateChannelCache(asAccountId(row.account_id));
        } catch {
          // Non-blocking — cache expires via TTL anyway
        }
        // Log only the business_id — never raw owner_email. Worker logs
        // aggregate into Sentry / Railway / etc. where PII becomes a
        // permanent record subject to GDPR/CCPA scrubbing requests. If
        // oncall needs the email for a specific row they can query
        // `SELECT owner_email FROM businesses WHERE id = '<biz_id>'`.
        // Same posture as the error + run-complete logs in this file
        // and the PII-redaction pattern in worker/ingress/telegram/telegram.ts.
        logger.log(
          `Backfilled email channel for business ${row.business_id}`,
        );
      }
    } catch (err) {
      // A 23505 unique violation from a concurrent INSERT racing our
      // transaction is benign — the row exists, which is the desired end
      // state. Count it as a non-insert, not a failure.
      const pg = err as { code?: string };
      if (pg?.code === '23505') {
        // Benign race — concurrent writer won. Same as ON CONFLICT DO NOTHING.
        continue;
      }
      failed++;
      logger.error(
        `INSERT failed for business ${row.business_id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (candidates.length > 0 || inserted > 0 || failed > 0) {
    logger.log(
      `Run complete: candidates=${candidates.length} inserted=${inserted} failed=${failed}`,
    );
  }
  return { candidates: candidates.length, inserted, failed };
}

export function startEmailChannelReconcilePoller(): void {
  if (process.env.EMAIL_CHANNEL_RECONCILE_DISABLED === 'true') {
    console.log(
      '[EmailChannelReconcile] EMAIL_CHANNEL_RECONCILE_DISABLED=true — not starting',
    );
    return;
  }
  if (process.env.MOCK_EXTERNAL_APIS === 'true') {
    console.log(
      '[EmailChannelReconcile] MOCK_EXTERNAL_APIS=true — not starting',
    );
    return;
  }

  // Idempotent start: see CleanupAbandonedSignupsPoller for rationale.
  if (timer !== null) {
    console.log(
      '[EmailChannelReconcile] Already started — ignoring duplicate startEmailChannelReconcilePoller() call',
    );
    return;
  }

  const envInterval = process.env.EMAIL_CHANNEL_RECONCILE_INTERVAL_MS;
  const parsed = envInterval ? parseInt(envInterval, 10) : NaN;
  const interval =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;

  console.log(`[EmailChannelReconcile] Starting (interval=${interval}ms)`);
  runOnce().catch((err) =>
    console.error('[EmailChannelReconcile] Initial run failed:', err),
  );
  timer = setInterval(() => {
    runOnce().catch((err) =>
      console.error('[EmailChannelReconcile] Scheduled run failed:', err),
    );
  }, interval);
}

export function stopEmailChannelReconcilePoller(): void {
  // See CleanupAbandonedSignupsPoller for the !== null vs truthy reasoning.
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  // Do NOT reset inProgress. If stop() fires mid-runOnce (graceful
  // shutdown), the in-flight run's finally{} clears the flag itself.
  // Racing it from stop() would let a fresh start() schedule a tick
  // that runs in PARALLEL with the still-executing run, defeating the
  // single-flight guarantee. Pattern matches CleanupAbandonedSignupsPoller.
}
