import { sql } from '../../src/lib/db/server';
import { createWorkerLogger } from '../../src/lib/shared/logger';
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
 * who lack a verified email enrollment and inserts one. Idempotent via the
 * existing partial-unique constraint on (business_id, channel) WHERE
 * archived_at IS NULL.
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

let timer: ReturnType<typeof setInterval> | null = null;

interface MissingChannelRow {
  business_id: string;
  owner_email: string;
}

export async function runOnce(): Promise<{
  candidates: number;
  inserted: number;
  failed: number;
}> {
  const logger = createWorkerLogger('[EmailChannelReconcile]');
  const envBatch = process.env.EMAIL_CHANNEL_RECONCILE_BATCH_SIZE;
  const parsedBatch = envBatch ? parseInt(envBatch, 10) : NaN;
  const batchSize =
    Number.isFinite(parsedBatch) && parsedBatch > 0
      ? parsedBatch
      : DEFAULT_BATCH_SIZE;

  const candidates = await sql<MissingChannelRow[]>`
    SELECT b.id AS business_id, b.owner_email
    FROM businesses b
    JOIN users u ON u.business_id = b.id AND u.role = 'owner'
    WHERE b.subscription_status = 'active'
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
      const result = await sql`
        INSERT INTO channel_enrollments (id, business_id, channel, handle, status, verified_at)
        VALUES (${uuidv7()}, ${row.business_id}, 'email', ${row.owner_email}, 'verified', NOW())
        ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO NOTHING
      `;
      // result.count === 1 → inserted; 0 → another writer raced us, that's fine
      if (result.count > 0) {
        inserted++;
        logger.log(
          `Backfilled email channel for business ${row.business_id} (handle=${row.owner_email})`,
        );
      }
    } catch (err) {
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
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
