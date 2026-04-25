import { sql, supabaseServer } from '../../src/lib/db/server';
import { createWorkerLogger } from '../../src/lib/shared/logger';

const DEFAULT_INTERVAL_MS = 86_400_000; // 24 hours
const DEFAULT_BATCH_SIZE = 100;

let timer: ReturnType<typeof setInterval> | null = null;

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
    LIMIT ${batchSize}
  `;

  let deleted = 0;
  let skippedRefs = 0;
  let supabaseFailed = 0;

  for (const candidate of candidates) {
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${candidate.owner_email + ':signup'}))`;

        const [refs] = await tx<{ has_onboarded: boolean; has_demos: boolean }[]>`
          SELECT
            EXISTS (SELECT 1 FROM businesses WHERE onboarded_by = ${candidate.user_id}) AS has_onboarded,
            EXISTS (SELECT 1 FROM prospect_demos WHERE created_by = ${candidate.user_id}) AS has_demos
        `;

        if (refs && (refs.has_onboarded || refs.has_demos)) {
          logger.warn(
            `Skipping ${candidate.user_id} — referenced by other tables (invariant violation): has_onboarded=${refs.has_onboarded} has_demos=${refs.has_demos}`,
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

        // FK-aware ordering: users.business_id does NOT cascade from businesses,
        // so users MUST be deleted first.
        await tx`DELETE FROM users WHERE id = ${candidate.user_id}`;
        await tx`DELETE FROM businesses WHERE id = ${candidate.business_id}`;
        deleted++;
      });
    } catch (err) {
      logger.error(
        `Cleanup tx failed for business ${candidate.business_id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  logger.log(
    `Run complete: candidates=${candidates.length} deleted=${deleted} skipped_refs=${skippedRefs} supabase_failed=${supabaseFailed}`,
  );
}

export function startCleanupAbandonedSignupsPoller(): void {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    console.log(
      '[CleanupAbandonedSignups] SELF_SERVE_SIGNUP_ENABLED != true — not starting',
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
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
