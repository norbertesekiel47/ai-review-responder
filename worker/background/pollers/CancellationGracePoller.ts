// worker/background/pollers/CancellationGracePoller.ts
//
// Polls for cancelled accounts that have passed the 30-day grace period
// and soft-archives their locations by setting businesses.archived_at.
//
// VAL-BILLING-048: Subscription cancellation sets all locations to read-only
//   (workers skip via isAccountActive guard).
// VAL-BILLING-049: 30-day grace period before automatic soft-archive of locations.
//
// During the grace period, locations are read-only (workers skip them via
// the isAccountActive check), but the data is preserved. After 30 days,
// this poller soft-archives all remaining active locations.

import { v7 as uuidv7 } from 'uuid';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql, jsonb } from '../../../src/lib/db/server';
import { createWorkerLogger, toError, type WorkerLogger } from '../../../src/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';

const LOG_PREFIX = '[CancellationGracePoller]';
const DEFAULT_INTERVAL_MS = 86_400_000; // 24 hours
// Hard per-cycle deadline (#414). 30min is far above a real cycle (expired-account
// scan + per-account soft-archive tx → minutes) and well under the 24h interval,
// so a cycle hung on a stale connection frees the single-flight flag before the
// next tick instead of pinning it forever and silently disabling grace archival.
const GRACE_CYCLE_TIMEOUT_MS = 1_800_000; // 30 minutes

function getIntervalMs(): number {
  const envVal = getWorkerConfig().CANCELLATION_GRACE_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

async function runCancellationGrace(logger: WorkerLogger): Promise<void> {
  try {
    // Find accounts that have been cancelled for more than 30 days
    // and still have active (non-archived) locations
    const expiredAccounts = await sql<{
      account_id: string;
      cancelled_count: number;
    }[]>`
      SELECT a.id AS account_id, COUNT(b.id) AS cancelled_count
      FROM accounts a
      JOIN businesses b ON b.account_id = a.id
      WHERE a.subscription_status = 'cancelled'  -- enum: SubscriptionStatus.CANCELLED
        AND a.cancelled_at IS NOT NULL
        AND a.cancelled_at < NOW() - INTERVAL '30 days'
        AND b.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM account_offboardings ao
          WHERE ao.account_id = a.id
        )
      GROUP BY a.id
    `;

    if (expiredAccounts.length === 0) {
      logger.log('No expired cancelled accounts to archive');
      return;
    }

    for (const { account_id, cancelled_count } of expiredAccounts) {
      logger.log('Soft-archiving locations for expired cancelled account', {
        account_id,
        cancelled_count,
      });

      await sql.begin(async (tx) => {
        // Soft-archive all active locations and use the updated row set for
        // audit logs. A second timestamp-window SELECT can pick up unrelated
        // rows archived by another process in the same time window.
        const locations = await tx<{ id: string; display_label: string | null; name: string }[]>`
          UPDATE businesses
          SET archived_at = NOW(), updated_at = NOW()
          WHERE account_id = ${account_id}::uuid
            AND archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM account_offboardings ao
              WHERE ao.account_id = ${account_id}::uuid
            )
          RETURNING id, display_label, name
        `;

        for (const loc of locations) {
          await tx`
            INSERT INTO account_audit_log (
              id, account_id, location_id, event_type, payload
            ) VALUES (
              ${uuidv7()}::uuid,
              ${account_id}::uuid,
              ${loc.id}::uuid,
              'location_soft_archived_grace_expired',
              ${jsonb({
                display_label: loc.display_label,
                name: loc.name,
                reason: 'cancellation_grace_period_expired',
              })}
            )
          `;
        }
      });
    }

    logger.log('Processed expired cancelled accounts', { account_count: expiredAccounts.length });
  } catch (error) {
    logger.error('Grace period archival cycle failed', toError(error));
  }
}

const guard = createGuardedPoll(runCancellationGrace, {
  label: LOG_PREFIX,
  intervalMs: getIntervalMs,
  timeoutMs: GRACE_CYCLE_TIMEOUT_MS,
  onErrorMessage: 'Grace period archival cycle failed',
});

export function startCancellationGracePoller(): void {
  guard.start(() =>
    createWorkerLogger(LOG_PREFIX).log('Starting', { interval_ms: getIntervalMs() }),
  );
}

export function stopCancellationGracePoller(): void {
  guard.stop();
}
