import { accountOffboardingEnabled } from '../../../src/lib/account-offboarding/flags';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql } from '../../../src/lib/db/server';
import { enqueueAccountOffboardingTeardown } from '../../../src/lib/shared/job-outbox-helpers';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { maybeLogPollerHeartbeat, notePollerActivity } from '../poller-heartbeat';
import { createGuardedPoll } from '../guarded-poll';

const LOG_PREFIX = '[AccountOffboardingAccessEndPoller]';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;
// Hard per-cycle deadline (#414). 45s is far above a real cycle (batched
// claim+enqueue, <=100 small txns → seconds) and under the 60s interval, so a
// cycle hung on a stale connection frees the single-flight flag before the next
// tick instead of pinning it forever and silently disabling access-end teardown.
const ACCESS_END_CYCLE_TIMEOUT_MS = 45_000;

interface ClaimableOffboardingRow {
  id: string;
  account_id: string;
  mode: 'cancel_only';
  status: 'scheduled';
  access_ends_at: Date | string;
}

interface ClaimedOffboardingRow {
  id: string;
  account_id: string;
  mode: 'cancel_only';
  status: 'tearing_down';
  access_ends_at: Date | string;
}

type ClaimResult =
  | { kind: 'none' }
  | { kind: 'skipped' }
  | { kind: 'claimed'; offboardingId: string };

function getIntervalMs(): number {
  const raw = parseInt(getWorkerConfig().ACCOUNT_OFFBOARDING_ACCESS_END_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

function getBatchSize(): number {
  const raw = parseInt(getWorkerConfig().ACCOUNT_OFFBOARDING_ACCESS_END_BATCH_SIZE || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_BATCH_SIZE;
  if (raw > 100) return 100;
  return raw;
}

const guard = createGuardedPoll(
  async (logger) => {
    if (!accountOffboardingEnabled()) return;
    await runAccountOffboardingAccessEndInner(logger);
  },
  {
    label: LOG_PREFIX,
    intervalMs: getIntervalMs,
    timeoutMs: ACCESS_END_CYCLE_TIMEOUT_MS,
    onSkipMessage: 'Previous run still in progress - skipping this tick',
  },
);

export const runAccountOffboardingAccessEndOnce = guard.runOnce;

async function runAccountOffboardingAccessEndInner(
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<void> {
  const batchSize = getBatchSize();
  let claimedCount = 0;

  for (let i = 0; i < batchSize; i++) {
    const result = await sql.begin(async (tx) => {
      const [candidate] = await tx<ClaimableOffboardingRow[]>`
        SELECT id, account_id, mode, status, access_ends_at
        FROM account_offboardings
        WHERE mode = 'cancel_only'
          AND status = 'scheduled'
          AND access_ends_at IS NOT NULL
          AND access_ends_at <= NOW()
          AND reactivation_claimed_at IS NULL
          AND teardown_started_at IS NULL
          AND terminal_at IS NULL
        ORDER BY access_ends_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      if (!candidate) {
        return { kind: 'none' } satisfies ClaimResult;
      }

      const [claimed] = await tx<ClaimedOffboardingRow[]>`
        UPDATE account_offboardings
        SET status = 'tearing_down',
            teardown_started_at = NOW(),
            failed_step = NULL,
            last_error = NULL,
            updated_at = NOW()
        WHERE id = ${candidate.id}::uuid
          AND account_id = ${candidate.account_id}::uuid
          AND mode = 'cancel_only'
          AND status = 'scheduled'
          AND access_ends_at IS NOT NULL
          AND access_ends_at <= NOW()
          AND reactivation_claimed_at IS NULL
          AND teardown_started_at IS NULL
          AND terminal_at IS NULL
        RETURNING id, account_id, mode, status, access_ends_at
      `;

      if (!claimed) {
        logger.log('Skipped - state changed before teardown claim', {
          offboarding_id: candidate.id,
        });
        return { kind: 'skipped' } satisfies ClaimResult;
      }

      await writeAccountAuditLog(
        {
          accountId: claimed.account_id,
          eventType: 'account_offboarding_teardown_started',
          entityType: 'account_offboarding',
          entityId: claimed.id,
          payload: {
            mode: claimed.mode,
            status: 'tearing_down',
            access_ends_at: formatTimestamp(claimed.access_ends_at),
          },
        },
        tx,
      );

      await enqueueAccountOffboardingTeardown(tx, {
        accountOffboardingId: claimed.id,
        accountId: claimed.account_id,
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

export function startAccountOffboardingAccessEndPoller(): void {
  const logger = createWorkerLogger(LOG_PREFIX);
  if (!accountOffboardingEnabled()) {
    logger.log('ACCOUNT_OFFBOARDING_ENABLED != true — not starting');
    return;
  }
  guard.start(() =>
    logger.log('Starting', { interval_ms: getIntervalMs(), batch: getBatchSize() }),
  );
}

export function stopAccountOffboardingAccessEndPoller(): void {
  guard.stop();
}
