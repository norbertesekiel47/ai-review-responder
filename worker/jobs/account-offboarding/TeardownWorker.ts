import type { Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import { sql } from '../../../src/lib/db/server';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxFailed,
} from '../../../src/lib/shared/outbox';
import type { AccountOffboardingTeardownPayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import type {
  AccountOffboardingMode,
  AccountOffboardingStatus,
  AccountOffboardingStepOutcome,
} from '../../../src/lib/account-offboarding/types';
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
    const safeMessage = scrubErrorForStorage(validationError);
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
    const safeMessage = scrubErrorForStorage(errorMessage(err));
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
  const terminalStatus = row.mode === 'delete_data'
    ? row.purge_cancelled_at !== null
      ? 'churned'
      : 'purge_scheduled'
    : 'churned';

  const [completed] = await sql<{ id: string; status: string }[]>`
    UPDATE account_offboardings
    SET teardown_completed_at = NOW(),
        status = ${terminalStatus},
        terminal_at = CASE
          WHEN ${terminalStatus} = 'churned' THEN COALESCE(terminal_at, NOW())
          ELSE terminal_at
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

  return Boolean(completed);
}

async function markTeardownFailed(
  row: AccountOffboardingTeardownRow,
  safeMessage: string,
  failedColumn: FailureStepColumn | undefined,
): Promise<void> {
  if (failedColumn === 'stripe_step') {
    await sql`
      UPDATE account_offboardings
      SET status = 'failed',
          failed_step = 'teardown',
          stripe_step = 'failed',
          last_error = ${safeMessage},
          retry_count = retry_count + 1,
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${row.account_id}::uuid
        AND terminal_at IS NULL
    `;
    return;
  }

  if (failedColumn === 'zernio_accounts_step') {
    await sql`
      UPDATE account_offboardings
      SET status = 'failed',
          failed_step = 'teardown',
          zernio_accounts_step = 'failed',
          last_error = ${safeMessage},
          retry_count = retry_count + 1,
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${row.account_id}::uuid
        AND terminal_at IS NULL
    `;
    return;
  }

  if (failedColumn === 'zernio_profiles_step') {
    await sql`
      UPDATE account_offboardings
      SET status = 'failed',
          failed_step = 'teardown',
          zernio_profiles_step = 'failed',
          last_error = ${safeMessage},
          retry_count = retry_count + 1,
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${row.account_id}::uuid
        AND terminal_at IS NULL
    `;
    return;
  }

  if (failedColumn === 'location_archival_step') {
    await sql`
      UPDATE account_offboardings
      SET status = 'failed',
          failed_step = 'teardown',
          location_archival_step = 'failed',
          last_error = ${safeMessage},
          retry_count = retry_count + 1,
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${row.account_id}::uuid
        AND terminal_at IS NULL
    `;
    return;
  }

  if (failedColumn === 'job_terminalization_step') {
    await sql`
      UPDATE account_offboardings
      SET status = 'failed',
          failed_step = 'teardown',
          job_terminalization_step = 'failed',
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

function isTerminalAttempt(job: Job<unknown>): boolean {
  const maxAttempts = typeof job.opts.attempts === 'number' && job.opts.attempts > 0
    ? job.opts.attempts
    : 1;
  return job.attemptsMade >= maxAttempts || job.attemptsMade + 1 >= maxAttempts;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scrubErrorForStorage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/]+=*/gi, 'Basic [REDACTED]')
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|token|secret))=([^&\s"']+)/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /([?&]\s*(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|token|secret)=)([^&\s"']+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /("?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|token|secret)"?\s*:\s*)"[^"]*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /('(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|token|secret)'\s*:\s*)'[^']*'/gi,
      `$1'[REDACTED]'`,
    )
    .slice(0, 500);
}
