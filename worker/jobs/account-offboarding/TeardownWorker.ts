import type { Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import { sql } from '../../../src/lib/db/server';
import {
  errorMessage,
  extractOutboxHandle,
  isTerminalAttempt,
  markOutboxCompleted,
  markOutboxFailed,
} from '../../../src/lib/shared/outbox';
import type { AccountOffboardingTeardownPayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { enqueueAccountOffboardingEmail } from '../../../src/lib/account-offboarding/outbox';
import type {
  AccountOffboardingMode,
  AccountOffboardingStatus,
  AccountOffboardingStepOutcome,
} from '../../../src/lib/account-offboarding/types';
import { enqueueOffboardingTeardownCompleted } from '../../../src/lib/account-offboarding/analytics';
import { scrubOffboardingErrorForStorage } from '../../../src/lib/account-offboarding/scrub-error';
import { runStripeTeardown, verifyCancelOnlyNaturalCancellation } from './teardown-stripe';
import { runZernioTeardown } from './teardown-zernio';
import { runLocationTeardown } from './teardown-locations';
import { runOutboxTerminalization } from './teardown-outbox';

interface AccountOffboardingTeardownRow {
  id: string;
  account_id: string;
  mode: AccountOffboardingMode;
  status: AccountOffboardingStatus;
  terminal_at: Date | string | null;
  access_ends_at: Date | string | null;
  teardown_started_at: Date | string | null;
  teardown_completed_at: Date | string | null;
  purge_cancelled_at: Date | string | null;
  stripe_subscription_id: string | null;
  zernio_account_ids: string[] | null;
  zernio_profile_ids: string[] | null;
  location_ids: string[] | null;
  stripe_step: AccountOffboardingStepOutcome | null;
  zernio_accounts_step: AccountOffboardingStepOutcome | null;
  zernio_profiles_step: AccountOffboardingStepOutcome | null;
  location_archival_step: AccountOffboardingStepOutcome | null;
  job_terminalization_step: AccountOffboardingStepOutcome | null;
}

type FailureStepColumn =
  | 'stripe_step'
  | 'zernio_accounts_step'
  | 'zernio_profiles_step'
  | 'location_archival_step'
  | 'job_terminalization_step';

export async function handleAccountOffboardingTeardown(
  job: Job<AccountOffboardingTeardownPayload>,
): Promise<void> {
  const logger = createWorkerLogger(
    '[AccountOffboardingTeardownWorker]',
    job.data.correlation_id,
  );
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const [offboarding] = await sql<AccountOffboardingTeardownRow[]>`
    SELECT id, account_id, mode, status, terminal_at, access_ends_at,
           teardown_started_at, teardown_completed_at, purge_cancelled_at,
           stripe_subscription_id, zernio_account_ids, zernio_profile_ids, location_ids,
           stripe_step, zernio_accounts_step, zernio_profiles_step,
           location_archival_step, job_terminalization_step
    FROM account_offboardings
    WHERE id = ${job.data.account_offboarding_id}::uuid
      AND account_id = ${job.data.account_id}::uuid
  `;

  if (!offboarding) {
    await markOutboxFailed(outboxId, 'account_offboarding_not_found', outboxAttempt);
    return;
  }

  if (offboarding.teardown_completed_at !== null || offboarding.terminal_at !== null) {
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const validationError = validateTeardownableOffboarding(offboarding);
  if (validationError) {
    const safeMessage = scrubOffboardingErrorForStorage(validationError);
    alertTeardownFailure(job.data, safeMessage, isTerminalAttempt(job));
    if (!isTerminalAttempt(job)) {
      throw new Error(safeMessage);
    }
    await markTeardownFailed(offboarding, safeMessage, undefined);
    await markOutboxFailed(outboxId, safeMessage, outboxAttempt);
    return;
  }

  try {
    if (offboarding.mode === 'cancel_only') {
      await verifyCancelOnlyTeardownReady(offboarding);
    }

    await markTeardownStarted(offboarding);
    offboarding.status = 'tearing_down';
    offboarding.teardown_started_at ??= new Date();

    await runStripeTeardown(offboarding);
    offboarding.stripe_step = resolveStripeStepOutcome(offboarding);
    await runZernioTeardown(offboarding);
    offboarding.zernio_accounts_step = resolveArrayStepOutcome(offboarding.zernio_account_ids);
    offboarding.zernio_profiles_step = resolveArrayStepOutcome(offboarding.zernio_profile_ids);
    await runLocationTeardown(offboarding);
    offboarding.location_archival_step = resolveArrayStepOutcome(offboarding.location_ids);
    await runOutboxTerminalization(offboarding, outboxId);
    offboarding.job_terminalization_step = 'success';

    const completed = await finalizeTeardown(offboarding);
    if (!completed) {
      throw new Error('account_offboarding_teardown_incomplete');
    }
  } catch (err) {
    const safeMessage = scrubOffboardingErrorForStorage(errorMessage(err));
    logger.error(`Teardown failed for offboarding ${offboarding.id}: ${safeMessage}`);
    alertTeardownFailure(job.data, safeMessage, isTerminalAttempt(job));
    if (!isTerminalAttempt(job)) {
      throw new Error(safeMessage);
    }

    await markTeardownFailed(offboarding, safeMessage, failureColumnForErrorStep(offboarding));
    await markOutboxFailed(outboxId, safeMessage, outboxAttempt);
    return;
  }

  await markOutboxCompleted(outboxId, outboxAttempt);
}

async function markTeardownStarted(row: AccountOffboardingTeardownRow): Promise<void> {
  await sql`
    UPDATE account_offboardings
    SET status = 'tearing_down',
        teardown_started_at = COALESCE(teardown_started_at, NOW()),
        failed_step = NULL,
        last_error = NULL,
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
      AND terminal_at IS NULL
  `;
}

async function finalizeTeardown(row: AccountOffboardingTeardownRow): Promise<boolean> {
  // Derive the terminal status from the LIVE purge_cancelled_at column, not the
  // in-memory snapshot loaded at the start of the job. A keep-my-data request can
  // cancel the purge while teardown is mid-flight; reading the stale snapshot would
  // land purge_scheduled and strand the row non-terminal forever (it would never
  // reach churned, blocking the account from ever offboarding again).
  return sql.begin(async (tx) => {
    const [completed] = await tx<{ id: string; status: 'churned' | 'purge_scheduled' }[]>`
      UPDATE account_offboardings
      SET teardown_completed_at = NOW(),
          status = CASE
            WHEN ${row.mode} = 'delete_data' AND purge_cancelled_at IS NOT NULL THEN 'churned'
            WHEN ${row.mode} = 'delete_data' THEN 'purge_scheduled'
            ELSE 'churned'
          END,
          terminal_at = CASE
            WHEN ${row.mode} = 'delete_data' AND purge_cancelled_at IS NULL THEN terminal_at
            ELSE COALESCE(terminal_at, NOW())
          END,
          failed_step = NULL,
          last_error = NULL,
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${row.account_id}::uuid
        AND (
          (stripe_subscription_id IS NULL AND stripe_step IN ('success', 'not_applicable'))
          OR (stripe_subscription_id IS NOT NULL AND stripe_step = 'success')
        )
        AND (
          (COALESCE(array_length(zernio_account_ids, 1), 0) = 0 AND zernio_accounts_step IN ('success', 'not_applicable'))
          OR (COALESCE(array_length(zernio_account_ids, 1), 0) > 0 AND zernio_accounts_step = 'success')
        )
        AND (
          (COALESCE(array_length(zernio_profile_ids, 1), 0) = 0 AND zernio_profiles_step IN ('success', 'not_applicable'))
          OR (COALESCE(array_length(zernio_profile_ids, 1), 0) > 0 AND zernio_profiles_step = 'success')
        )
        AND (
          (COALESCE(array_length(location_ids, 1), 0) = 0 AND location_archival_step IN ('success', 'not_applicable'))
          OR (COALESCE(array_length(location_ids, 1), 0) > 0 AND location_archival_step = 'success')
        )
        AND job_terminalization_step = 'success'
      RETURNING id, status
    `;

    if (!completed) return false;

    await enqueueOffboardingTeardownCompleted(tx, {
      accountId: row.account_id,
      offboardingId: row.id,
      mode: row.mode,
      status: completed.status,
    });

    // cancel_only access ended → tell the owner their subscription has ended.
    // (delete_data landing churned was rescued by keep-my-data, which sends its
    // own confirmation; landing purge_scheduled gets the purge receipt later.)
    if (row.mode === 'cancel_only' && completed.status === 'churned') {
      await enqueueAccountOffboardingEmail(tx, {
        accountOffboardingId: row.id,
        accountId: row.account_id,
        emailType: 'cancel_only_access_end',
      });
    }
    return true;
  });
}

async function markTeardownFailed(
  row: AccountOffboardingTeardownRow,
  safeMessage: string,
  failedColumn: FailureStepColumn | undefined,
): Promise<void> {
  // failedColumn is a closed union (FailureStepColumn), so the identifier interpolation
  // can only ever be one of the five known per-step columns — never untrusted input.
  if (failedColumn) {
    await sql`
      UPDATE account_offboardings
      SET status = 'failed',
          failed_step = 'teardown',
          ${sql(failedColumn)} = 'failed',
          last_error = ${safeMessage},
          retry_count = retry_count + 1,
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${row.account_id}::uuid
        AND terminal_at IS NULL
    `;
    return;
  }

  await sql`
    UPDATE account_offboardings
    SET status = 'failed',
        failed_step = 'teardown',
        last_error = ${safeMessage},
        retry_count = retry_count + 1,
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
      AND terminal_at IS NULL
  `;
}

function validateTeardownableOffboarding(row: AccountOffboardingTeardownRow): string | null {
  if (row.mode === 'delete_data') {
    if (row.status !== 'pending' && row.status !== 'tearing_down') {
      return `account_offboarding_status_not_delete_data_teardownable:${row.status}`;
    }
    return null;
  }

  if (row.status !== 'scheduled' && row.status !== 'tearing_down') {
    return `account_offboarding_status_not_cancel_only_teardownable:${row.status}`;
  }
  if (!row.access_ends_at) {
    return 'account_offboarding_missing_access_end';
  }
  return null;
}

async function verifyCancelOnlyTeardownReady(
  row: AccountOffboardingTeardownRow,
): Promise<void> {
  if (!row.access_ends_at || new Date(row.access_ends_at).getTime() > Date.now()) {
    throw new Error('account_offboarding_access_end_not_reached');
  }
  await verifyCancelOnlyNaturalCancellation(row);
}

function failureColumnForErrorStep(
  row: AccountOffboardingTeardownRow,
): FailureStepColumn | undefined {
  if (requiresStripeSuccess(row)) {
    return 'stripe_step';
  }
  if (requiresArrayStepSuccess(row.zernio_account_ids, row.zernio_accounts_step)) {
    return 'zernio_accounts_step';
  }
  if (requiresArrayStepSuccess(row.zernio_profile_ids, row.zernio_profiles_step)) {
    return 'zernio_profiles_step';
  }
  if (requiresArrayStepSuccess(row.location_ids, row.location_archival_step)) {
    return 'location_archival_step';
  }
  if (row.job_terminalization_step !== 'success') {
    return 'job_terminalization_step';
  }
  return undefined;
}

function resolveStripeStepOutcome(
  row: Pick<AccountOffboardingTeardownRow, 'stripe_subscription_id'>,
): AccountOffboardingStepOutcome {
  return row.stripe_subscription_id?.trim() ? 'success' : 'not_applicable';
}

function resolveArrayStepOutcome(values: string[] | null): AccountOffboardingStepOutcome {
  return (values ?? []).some((value) => value.trim().length > 0)
    ? 'success'
    : 'not_applicable';
}

function requiresStripeSuccess(
  row: Pick<AccountOffboardingTeardownRow, 'stripe_subscription_id' | 'stripe_step'>,
): boolean {
  return Boolean(row.stripe_subscription_id?.trim()) && row.stripe_step !== 'success';
}

function requiresArrayStepSuccess(
  values: string[] | null,
  step: AccountOffboardingStepOutcome | null,
): boolean {
  return (values ?? []).some((value) => value.trim().length > 0) && step !== 'success';
}

function alertTeardownFailure(
  payload: AccountOffboardingTeardownPayload,
  safeMessage: string,
  terminal: boolean,
): void {
  Sentry.captureMessage('account_offboarding_teardown_failed', {
    level: terminal ? 'error' : 'warning',
    tags: {
      subsystem: 'account_offboarding',
      step: 'teardown',
      terminal: String(terminal),
    },
    extra: {
      account_offboarding_id: payload.account_offboarding_id,
      account_id: payload.account_id,
      error: safeMessage,
    },
  });
}

