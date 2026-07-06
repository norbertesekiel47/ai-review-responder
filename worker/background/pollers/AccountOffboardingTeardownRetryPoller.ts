import { accountOffboardingEnabled } from '../../../src/lib/account-offboarding/flags';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql } from '../../../src/lib/db/server';
import { enqueueAccountOffboardingTeardown } from '../../../src/lib/account-offboarding/outbox';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { maybeLogPollerHeartbeat, notePollerActivity } from '../poller-heartbeat';
import { createGuardedPoll } from '../guarded-poll';

// Autonomous re-drive for teardowns that exhausted their BullMQ attempts and
// landed status='failed', failed_step='teardown' (both modes). Without this a
// transient provider outage during teardown leaves the row stuck non-terminal
// with no autonomous recovery — only the (delete_data-only) admin provider
// disposition path could move it. Teardown steps are idempotent and early-return
// on 'success', so re-driving only retries the step that actually failed.
//
// Bounded against retry storms: a per-row cooldown (so a row that just failed is
// not re-driven on the next tick) and a hard retry cap (after which the row is
// left for an operator). retry_count is incremented by the teardown worker on
// each failure, so it counts re-drive cycles.

const LOG_PREFIX = '[AccountOffboardingTeardownRetryPoller]';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 12;
// Hard per-cycle deadline (#414). 45s is far above a real cycle (claim+re-enqueue
// → seconds) and under the 60s interval, so a cycle hung on a stale connection
// frees the single-flight flag before the next tick instead of pinning it forever
// and silently disabling teardown re-drive.
const TEARDOWN_RETRY_CYCLE_TIMEOUT_MS = 45_000;

interface RetryableTeardownRow {
  id: string;
  account_id: string;
  mode: 'cancel_only' | 'delete_data';
}

function getIntervalMs(): number {
  const raw = parseInt(getWorkerConfig().ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

function getBatchSize(): number {
  const raw = parseInt(getWorkerConfig().ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_BATCH_SIZE || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_BATCH_SIZE;
  if (raw > 100) return 100;
  return raw;
}

function getCooldownSeconds(): number {
  const raw = parseInt(getWorkerConfig().ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_COOLDOWN_MS || '', 10);
  const ms = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COOLDOWN_MS;
  return Math.floor(ms / 1000);
}

function getMaxRetries(): number {
  const raw = parseInt(getWorkerConfig().ACCOUNT_OFFBOARDING_TEARDOWN_MAX_RETRIES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_RETRIES;
}

const guard = createGuardedPoll(
  async (logger) => {
    if (!accountOffboardingEnabled()) return;
    await runAccountOffboardingTeardownRetryInner(logger);
  },
  {
    label: LOG_PREFIX,
    intervalMs: getIntervalMs,
    timeoutMs: TEARDOWN_RETRY_CYCLE_TIMEOUT_MS,
    onSkipMessage: 'Previous run still in progress - skipping this tick',
  },
);

export const runAccountOffboardingTeardownRetryOnce = guard.runOnce;

async function runAccountOffboardingTeardownRetryInner(
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<void> {
  const batchSize = getBatchSize();
  const cooldownSeconds = getCooldownSeconds();
  const maxRetries = getMaxRetries();
  let redrivenCount = 0;

  for (let i = 0; i < batchSize; i++) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const result = await sql.begin(async (tx) => {
      const [candidate] = await tx<RetryableTeardownRow[]>`
        SELECT id, account_id, mode
        FROM account_offboardings
        WHERE status = 'failed'
          AND failed_step = 'teardown'
          AND terminal_at IS NULL
          AND retry_count < ${maxRetries}
          AND updated_at <= NOW() - make_interval(secs => ${cooldownSeconds})
        ORDER BY updated_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      if (!candidate) return { kind: 'none' as const };

      const [claimed] = await tx<{ id: string }[]>`
        UPDATE account_offboardings
        SET status = 'tearing_down',
            failed_step = NULL,
            last_error = NULL,
            teardown_started_at = COALESCE(teardown_started_at, NOW()),
            updated_at = NOW()
        WHERE id = ${candidate.id}::uuid
          AND account_id = ${candidate.account_id}::uuid
          AND status = 'failed'
          AND failed_step = 'teardown'
          AND terminal_at IS NULL
          AND retry_count < ${maxRetries}
        RETURNING id
      `;

      if (!claimed) return { kind: 'skipped' as const };

      await writeAccountAuditLog(tx, {
        accountId: candidate.account_id,
        eventType: 'account_offboarding_teardown_retry_scheduled',
        entityType: 'account_offboarding',
        entityId: candidate.id,
        payload: { mode: candidate.mode, status: 'tearing_down' },
      });

      await enqueueAccountOffboardingTeardown(tx, {
        accountOffboardingId: candidate.id,
        accountId: candidate.account_id,
      });

      return { kind: 'redriven' as const };
    });

    if (result.kind === 'none') break;
    if (result.kind === 'redriven') redrivenCount++;
  }

  if (redrivenCount > 0) {
    logger.log('Run complete', { redriven: redrivenCount });
    notePollerActivity(LOG_PREFIX);
  } else {
    maybeLogPollerHeartbeat(logger, LOG_PREFIX);
  }
}

export function startAccountOffboardingTeardownRetryPoller(): void {
  const logger = createWorkerLogger(LOG_PREFIX);
  if (!accountOffboardingEnabled()) {
    logger.log('ACCOUNT_OFFBOARDING_ENABLED != true — not starting');
    return;
  }
  guard.start(() =>
    logger.log('Starting', { interval_ms: getIntervalMs(), batch: getBatchSize() }),
  );
}

export function stopAccountOffboardingTeardownRetryPoller(): void {
  guard.stop();
}
