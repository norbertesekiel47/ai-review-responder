import { accountOffboardingEnabled } from '../../../src/lib/account-offboarding/flags';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { sql } from '../../../src/lib/db/server';
import { enqueueAccountOffboardingTeardown } from '../../../src/lib/shared/job-outbox-helpers';
import { createWorkerLogger, logUnhandledPollError, toError } from '../../../src/lib/shared/logger';

const LOG_PREFIX = '[AccountOffboardingAccessEndPoller]';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let inProgress = false;

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
  const raw = parseInt(process.env.ACCOUNT_OFFBOARDING_ACCESS_END_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

function getBatchSize(): number {
  const raw = parseInt(process.env.ACCOUNT_OFFBOARDING_ACCESS_END_BATCH_SIZE || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_BATCH_SIZE;
  if (raw > 100) return 100;
  return raw;
}

export async function runAccountOffboardingAccessEndOnce(): Promise<void> {
  if (!accountOffboardingEnabled()) return;

  const logger = createWorkerLogger(LOG_PREFIX);
  if (inProgress) {
    logger.log('Previous run still in progress - skipping this tick');
    return;
  }

  inProgress = true;
  try {
    await runAccountOffboardingAccessEndInner(logger);
  } catch (err) {
    logger.error('Poll cycle failed', toError(err));
  } finally {
    inProgress = false;
  }
}

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

  logger.log('Run complete', { claimed: claimedCount });
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

  if (pollerInterval) {
    return;
  }

  const intervalMs = getIntervalMs();
  logger.log('Starting', { interval_ms: intervalMs, batch: getBatchSize() });
  runAccountOffboardingAccessEndOnce().catch(logUnhandledPollError(LOG_PREFIX));
  pollerInterval = setInterval(() => {
    runAccountOffboardingAccessEndOnce().catch(logUnhandledPollError(LOG_PREFIX));
  }, intervalMs);
}

export function stopAccountOffboardingAccessEndPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    createWorkerLogger(LOG_PREFIX).log('Stopped');
  }
}
