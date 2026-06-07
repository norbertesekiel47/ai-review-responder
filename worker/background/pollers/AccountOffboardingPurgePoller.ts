import { accountOffboardingEnabled } from '../../../src/lib/account-offboarding/flags';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { sql } from '../../../src/lib/db/server';
import { enqueueAccountOffboardingPurge } from '../../../src/lib/shared/job-outbox-helpers';
import { createWorkerLogger } from '../../../src/lib/shared/logger';

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
  const raw = parseInt(process.env.ACCOUNT_OFFBOARDING_PURGE_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

function getBatchSize(): number {
  const raw = parseInt(process.env.ACCOUNT_OFFBOARDING_PURGE_BATCH_SIZE || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_BATCH_SIZE;
  if (raw > 100) return 100;
  return raw;
}

export function getAccountOffboardingPurgeWindowOverrideMs(): number | null {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
    return null;
  }

  const raw = parseInt(process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return raw;
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
    logger.error(
      `Poll cycle failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
        logger.log(
          `Skipped ${candidate.id} - state changed before purge claim`,
        );
        return { kind: 'skipped' } satisfies ClaimResult;
      }

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

  logger.log(`Run complete: claimed=${claimedCount}`);
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function startAccountOffboardingPurgePoller(): void {
  if (!accountOffboardingEnabled()) {
    console.log(`${LOG_PREFIX} ACCOUNT_OFFBOARDING_ENABLED != true - not starting`);
    return;
  }

  if (pollerInterval) {
    return;
  }

  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms, batch=${getBatchSize()})`);
  runAccountOffboardingPurgeOnce().catch(console.error);
  pollerInterval = setInterval(() => {
    runAccountOffboardingPurgeOnce().catch(console.error);
  }, intervalMs);
}

export function stopAccountOffboardingPurgePoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
