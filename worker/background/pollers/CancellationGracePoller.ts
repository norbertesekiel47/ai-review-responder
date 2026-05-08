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
import { sql, jsonb } from '../../../src/lib/db/server';

const LOG_PREFIX = '[CancellationGracePoller]';
const DEFAULT_INTERVAL_MS = 86_400_000; // 24 hours

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const envVal = process.env.CANCELLATION_GRACE_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

async function runCancellationGrace(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

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
      WHERE a.subscription_status = 'cancelled'
        AND b.archived_at IS NULL
        AND a.updated_at < NOW() - INTERVAL '30 days'
      GROUP BY a.id
    `;

    if (expiredAccounts.length === 0) {
      console.log(`${LOG_PREFIX} No expired cancelled accounts to archive`);
      return;
    }

    for (const { account_id, cancelled_count } of expiredAccounts) {
      console.log(`${LOG_PREFIX} Soft-archiving ${cancelled_count} locations for expired cancelled account ${account_id}`);

      await sql.begin(async (tx) => {
        // Soft-archive all active locations
        await tx`
          UPDATE businesses
          SET archived_at = NOW(), updated_at = NOW()
          WHERE account_id = ${account_id}::uuid
            AND archived_at IS NULL
        `;

        // Insert audit log entries for each archived location
        const locations = await tx<{ id: string; display_label: string | null; name: string }[]>`
          SELECT id, display_label, name
          FROM businesses
          WHERE account_id = ${account_id}::uuid
            AND archived_at IS NOT NULL
            AND archived_at > NOW() - INTERVAL '1 minute'
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

    console.log(`${LOG_PREFIX} Processed ${expiredAccounts.length} expired cancelled accounts`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Grace period archival cycle failed:`, error);
  } finally {
    isPolling = false;
  }
}

export function startCancellationGracePoller(): void {
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
  runCancellationGrace().catch(console.error);
  pollerInterval = setInterval(() => {
    runCancellationGrace().catch(console.error);
  }, intervalMs);
}

export function stopCancellationGracePoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
