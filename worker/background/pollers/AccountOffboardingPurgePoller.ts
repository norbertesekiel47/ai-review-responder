import { accountOffboardingEnabled } from '../../../src/lib/account-offboarding/flags';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql } from '../../../src/lib/db/server';
import { enqueueAccountOffboardingPurge } from '../../../src/lib/shared/job-outbox-helpers';
import { createWorkerLogger, logUnhandledPollError, toError } from '../../../src/lib/shared/logger';
import { maybeLogPollerHeartbeat, notePollerActivity } from '../poller-heartbeat';

const LOG_PREFIX = '[AccountOffboardingPurgePoller]';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let inProgress = false;

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
  const raw = parseInt(getWorkerConfig().ACCOUNT_OFFBOARDING_PURGE_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

function getBatchSize(): number {
  const raw = parseInt(getWorkerConfig().ACCOUNT_OFFBOARDING_PURGE_BATCH_SIZE || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_BATCH_SIZE;
  if (raw > 100) return 100;
  return raw;
}

// The override only ever SHORTENS the purge window for staging dry-runs. Cap it
// so a fat-fingered huge value cannot make every purge_scheduled row claimable
// at once (which would purge staging test data far earlier than intended).
const MAX_PURGE_WINDOW_OVERRIDE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export function getAccountOffboardingPurgeWindowOverrideMs(): number | null {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
    return null;
  }

  const raw = parseInt(getWorkerConfig().ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return Math.min(raw, MAX_PURGE_WINDOW_OVERRIDE_MS);
}

export async function runAccountOffboardingPurgeOnce(): Promise<void> {
  if (!accountOffboardingEnabled()) return;

  const logger = createWorkerLogger(LOG_PREFIX);
  if (inProgress) {
    logger.log('Previous run still in progress - skipping this tick');
    return;
  }

  inProgress = true;
  try {
    await runAccountOffboardingPurgeInner(logger);
  } catch (err) {
    logger.error('Poll cycle failed', toError(err));
  } finally {
    inProgress = false;
  }
}

async function runAccountOffboardingPurgeInner(
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<void> {
  const batchSize = getBatchSize();
  const purgeWindowOverrideMs = getAccountOffboardingPurgeWindowOverrideMs();
  let claimedCount = 0;

  for (let i = 0; i < batchSize; i++) {
    const result = await sql.begin(async (tx) => {
      const [candidate] = await tx<ClaimableOffboardingRow[]>`
        SELECT id, account_id, mode, status, purge_after
        FROM account_offboardings
        WHERE mode = 'delete_data'
          AND status = 'purge_scheduled'
          AND purge_after IS NOT NULL
          AND (
            purge_after <= NOW()
            OR (
              ${purgeWindowOverrideMs}::int IS NOT NULL
              AND purge_after <= NOW() + (${purgeWindowOverrideMs}::int * INTERVAL '1 millisecond')
            )
          )
          AND purge_cancelled_at IS NULL
          AND purge_started_at IS NULL
          AND terminal_at IS NULL
          AND (
            teardown_completed_at IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(provider_dispositions) AS disposition(value)
              WHERE disposition.value->>'type' = 'admin_provider_disposition'
                AND disposition.value->>'provider' IN ('stripe', 'zernio', 'google', 'supabase_auth', 'other')
                AND NULLIF(BTRIM(disposition.value->>'resource_type'), '') IS NOT NULL
                AND NULLIF(BTRIM(disposition.value->>'scrubbed_resource_reference'), '') IS NOT NULL
                AND NULLIF(BTRIM(disposition.value->>'admin_actor_user_id'), '') IS NOT NULL
                AND NULLIF(BTRIM(disposition.value->>'reason'), '') IS NOT NULL
                AND NULLIF(BTRIM(disposition.value->>'recorded_at'), '') IS NOT NULL
            )
          )
        ORDER BY purge_after ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      if (!candidate) {
        return { kind: 'none' } satisfies ClaimResult;
      }

      const [claimed] = await tx<ClaimableOffboardingRow[]>`
        UPDATE account_offboardings
        SET purge_started_at = NOW(),
            failed_step = NULL,
            last_error = NULL,
            updated_at = NOW()
        WHERE id = ${candidate.id}::uuid
          AND account_id = ${candidate.account_id}::uuid
          AND mode = 'delete_data'
          AND status = 'purge_scheduled'
          AND purge_after IS NOT NULL
          AND (
            purge_after <= NOW()
            OR (
              ${purgeWindowOverrideMs}::int IS NOT NULL
              AND purge_after <= NOW() + (${purgeWindowOverrideMs}::int * INTERVAL '1 millisecond')
            )
          )
          AND purge_cancelled_at IS NULL
          AND purge_started_at IS NULL
          AND terminal_at IS NULL
          AND (
            teardown_completed_at IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(provider_dispositions) AS disposition(value)
              WHERE disposition.value->>'type' = 'admin_provider_disposition'
                AND disposition.value->>'provider' IN ('stripe', 'zernio', 'google', 'supabase_auth', 'other')
                AND NULLIF(BTRIM(disposition.value->>'resource_type'), '') IS NOT NULL
                AND NULLIF(BTRIM(disposition.value->>'scrubbed_resource_reference'), '') IS NOT NULL
                AND NULLIF(BTRIM(disposition.value->>'admin_actor_user_id'), '') IS NOT NULL
                AND NULLIF(BTRIM(disposition.value->>'reason'), '') IS NOT NULL
                AND NULLIF(BTRIM(disposition.value->>'recorded_at'), '') IS NOT NULL
            )
          )
        RETURNING id, account_id, mode, status, purge_after
      `;

      if (!claimed) {
        logger.log('Skipped - state changed before purge claim', {
          offboarding_id: candidate.id,
        });
        return { kind: 'skipped' } satisfies ClaimResult;
      }

      // Sequential awaits share one Postgres.js claim transaction connection (sql.begin); token
      // revoke → audit log → outbox enqueue must commit atomically in this order and cannot run
      // in parallel on a single connection.
      // react-doctor-disable-next-line react-doctor/async-parallel
      await tx`
        UPDATE account_offboarding_tokens t
        SET revoked_at = NOW(),
            revoked_reason = 'purge_started'
        FROM account_offboardings ao
        WHERE t.account_offboarding_id = ao.id
          AND ao.id = ${claimed.id}::uuid
          AND ao.account_id = ${claimed.account_id}::uuid
          AND t.consumed_at IS NULL
          AND t.revoked_at IS NULL
      `;

      await writeAccountAuditLog(
        {
          accountId: claimed.account_id,
          eventType: 'account_offboarding_purge_started',
          entityType: 'account_offboarding',
          entityId: claimed.id,
          payload: {
            mode: claimed.mode,
            status: claimed.status,
            purge_after: formatTimestamp(claimed.purge_after),
          },
        },
        tx,
      );

      await enqueueAccountOffboardingPurge(tx, {
        accountOffboardingId: claimed.id,
        accountId: claimed.account_id,
        correlationId: undefined,
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

export function startAccountOffboardingPurgePoller(): void {
  const logger = createWorkerLogger(LOG_PREFIX);
  if (!accountOffboardingEnabled()) {
    logger.log('ACCOUNT_OFFBOARDING_ENABLED != true - not starting');
    return;
  }

  if (pollerInterval) {
    return;
  }

  const intervalMs = getIntervalMs();
  logger.log('Starting', { interval_ms: intervalMs, batch: getBatchSize() });
  runAccountOffboardingPurgeOnce().catch(logUnhandledPollError(LOG_PREFIX));
  pollerInterval = setInterval(() => {
    runAccountOffboardingPurgeOnce().catch(logUnhandledPollError(LOG_PREFIX));
  }, intervalMs);
}

export function stopAccountOffboardingPurgePoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    createWorkerLogger(LOG_PREFIX).log('Stopped');
  }
}
