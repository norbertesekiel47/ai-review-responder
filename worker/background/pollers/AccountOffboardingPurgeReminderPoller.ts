import { accountOffboardingEnabled } from '../../../src/lib/account-offboarding/flags';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql } from '../../../src/lib/db/server';
import { enqueueAccountOffboardingEmail } from '../../../src/lib/shared/job-outbox-helpers';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { maybeLogPollerHeartbeat, notePollerActivity } from '../poller-heartbeat';
import { createGuardedPoll } from '../guarded-poll';

const LOG_PREFIX = '[AccountOffboardingPurgeReminderPoller]';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;
// T-minus lead before purge_after at which the last-chance reminder is sent.
const REMINDER_LEAD_DAYS = 3;
// Hard per-cycle deadline (#414). 45s is far above a real cycle (claim+notify
// enqueue → seconds) and under the 60s interval, so a cycle hung on a stale
// connection frees the single-flight flag before the next tick instead of
// pinning it forever and silently disabling purge reminders.
const PURGE_REMINDER_CYCLE_TIMEOUT_MS = 45_000;

interface ClaimableOffboardingRow {
  id: string;
  account_id: string;
  mode: 'delete_data';
  status: 'purge_scheduled';
  purge_after: Date | string;
}

type ClaimResult =
  | { kind: 'none' }
  | { kind: 'skipped' }
  | { kind: 'claimed'; offboardingId: string };

function getIntervalMs(): number {
  const raw = parseInt(getWorkerConfig().ACCOUNT_OFFBOARDING_PURGE_REMINDER_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

function getBatchSize(): number {
  const raw = parseInt(getWorkerConfig().ACCOUNT_OFFBOARDING_PURGE_REMINDER_BATCH_SIZE || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_BATCH_SIZE;
  if (raw > 100) return 100;
  return raw;
}

const guard = createGuardedPoll(
  async (logger) => {
    if (!accountOffboardingEnabled()) return;
    await runAccountOffboardingPurgeReminderInner(logger);
  },
  {
    label: LOG_PREFIX,
    intervalMs: getIntervalMs,
    timeoutMs: PURGE_REMINDER_CYCLE_TIMEOUT_MS,
    onSkipMessage: 'Previous run still in progress - skipping this tick',
  },
);

export const runAccountOffboardingPurgeReminderOnce = guard.runOnce;

async function runAccountOffboardingPurgeReminderInner(
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<void> {
  const batchSize = getBatchSize();
  let claimedCount = 0;

  for (let i = 0; i < batchSize; i++) {
    const result = await sql.begin(async (tx) => {
      const [candidate] = await tx<ClaimableOffboardingRow[]>`
        SELECT id, account_id, mode, status, purge_after
        FROM account_offboardings
        WHERE mode = 'delete_data'
          AND status = 'purge_scheduled'
          AND purge_after IS NOT NULL
          AND purge_after > NOW()
          AND purge_after <= NOW() + (${REMINDER_LEAD_DAYS}::int * INTERVAL '1 day')
          AND purge_reminder_sent_at IS NULL
          AND purge_started_at IS NULL
          AND purge_cancelled_at IS NULL
          AND terminal_at IS NULL
        ORDER BY purge_after ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      if (!candidate) {
        return { kind: 'none' } satisfies ClaimResult;
      }

      const [claimed] = await tx<ClaimableOffboardingRow[]>`
        UPDATE account_offboardings
        SET purge_reminder_sent_at = NOW(),
            updated_at = NOW()
        WHERE id = ${candidate.id}::uuid
          AND account_id = ${candidate.account_id}::uuid
          AND mode = 'delete_data'
          AND status = 'purge_scheduled'
          AND purge_after IS NOT NULL
          AND purge_after > NOW()
          AND purge_after <= NOW() + (${REMINDER_LEAD_DAYS}::int * INTERVAL '1 day')
          AND purge_reminder_sent_at IS NULL
          AND purge_started_at IS NULL
          AND purge_cancelled_at IS NULL
          AND terminal_at IS NULL
        RETURNING id, account_id, mode, status, purge_after
      `;

      if (!claimed) {
        logger.log('Skipped - state changed before reminder claim', {
          offboarding_id: candidate.id,
        });
        return { kind: 'skipped' } satisfies ClaimResult;
      }

      await writeAccountAuditLog(tx, {
        accountId: claimed.account_id,
        eventType: 'account_offboarding_purge_reminder_sent',
        entityType: 'account_offboarding',
        entityId: claimed.id,
        payload: {
          mode: claimed.mode,
          status: claimed.status,
          purge_after: formatTimestamp(claimed.purge_after),
        },
      });

      await enqueueAccountOffboardingEmail(tx, {
        accountOffboardingId: claimed.id,
        accountId: claimed.account_id,
        emailType: 'delete_data_purge_reminder',
      });

      return {
        kind: 'claimed',
        offboardingId: claimed.id,
      } satisfies ClaimResult;
    });

    if (result.kind === 'none') {
      break;
    }
    if (result.kind === 'claimed') {
      claimedCount++;
    }
  }

  if (claimedCount > 0) {
    logger.log('Run complete', { claimed: claimedCount });
    notePollerActivity(LOG_PREFIX);
  } else {
    maybeLogPollerHeartbeat(logger, LOG_PREFIX);
  }
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function startAccountOffboardingPurgeReminderPoller(): void {
  const logger = createWorkerLogger(LOG_PREFIX);
  if (!accountOffboardingEnabled()) {
    logger.log('ACCOUNT_OFFBOARDING_ENABLED != true — not starting');
    return;
  }
  guard.start(() =>
    logger.log('Starting', { interval_ms: getIntervalMs(), batch: getBatchSize() }),
  );
}

export function stopAccountOffboardingPurgeReminderPoller(): void {
  guard.stop();
}
