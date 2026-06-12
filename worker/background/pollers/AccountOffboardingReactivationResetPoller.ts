import { getStripe } from '../../../src/lib/payments/stripe-client';
import { accountOffboardingEnabled } from '../../../src/lib/account-offboarding/flags';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { sql } from '../../../src/lib/db/server';
import { createWorkerLogger, logUnhandledPollError, toError } from '../../../src/lib/shared/logger';

// Autonomous recovery for stale cancel_only reactivation claims (M1). A claim is
// stale when its originating reactivation process died mid-reversal — the row sits
// status='scheduled' with reactivation_claimed_at set, blocking both the
// access-end teardown and any fresh reactivation, and Stripe may already be
// reversed (cancel_at_period_end=false) so natural cancellation would never be
// observed. This poller restores the canonical scheduled-to-cancel state and
// releases the claim so the row is no longer stranded.

const LOG_PREFIX = '[AccountOffboardingReactivationResetPoller]';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;
const STALE_REACTIVATION_CLAIM_MS = 5 * 60 * 1000;

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let inProgress = false;

interface StaleReactivationClaimRow {
  id: string;
  account_id: string;
  stripe_subscription_id: string | null;
  reactivation_claim_token: string | null;
}

function getIntervalMs(): number {
  const raw = parseInt(process.env.ACCOUNT_OFFBOARDING_REACTIVATION_RESET_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

function getBatchSize(): number {
  const raw = parseInt(process.env.ACCOUNT_OFFBOARDING_REACTIVATION_RESET_BATCH_SIZE || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_BATCH_SIZE;
  if (raw > 100) return 100;
  return raw;
}

export async function runAccountOffboardingReactivationResetOnce(): Promise<void> {
  if (!accountOffboardingEnabled()) return;

  const logger = createWorkerLogger(LOG_PREFIX);
  if (inProgress) {
    logger.log('Previous run still in progress - skipping this tick');
    return;
  }

  inProgress = true;
  try {
    await runAccountOffboardingReactivationResetInner(logger);
  } catch (err) {
    logger.error('Poll cycle failed', toError(err));
  } finally {
    inProgress = false;
  }
}

async function runAccountOffboardingReactivationResetInner(
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<void> {
  const staleSeconds = Math.floor(STALE_REACTIVATION_CLAIM_MS / 1000);
  const candidates = await sql<StaleReactivationClaimRow[]>`
    SELECT id, account_id, stripe_subscription_id, reactivation_claim_token
    FROM account_offboardings
    WHERE mode = 'cancel_only'
      AND status = 'scheduled'
      AND terminal_at IS NULL
      AND reactivated_at IS NULL
      AND teardown_started_at IS NULL
      AND reactivation_claimed_at IS NOT NULL
      AND reactivation_claimed_at <= NOW() - make_interval(secs => ${staleSeconds})
    ORDER BY reactivation_claimed_at ASC, id ASC
    LIMIT ${getBatchSize()}
  `;

  let resetCount = 0;
  for (const candidate of candidates) {
    // Each candidate is independent; one failure must not abort the rest.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const didReset = await resetStaleReactivationClaim(candidate, logger);
    if (didReset) resetCount++;
  }

  logger.log('Run complete', { reset: resetCount, candidates: candidates.length });
}

async function resetStaleReactivationClaim(
  candidate: StaleReactivationClaimRow,
  logger: ReturnType<typeof createWorkerLogger>,
): Promise<boolean> {
  const token = candidate.reactivation_claim_token;
  if (!token) return false;

  // 1) Restore Stripe to cancel_at_period_end=true (idempotent, same key the
  //    reactivation compensation uses). We do NOT hold a DB lock across this call;
  //    the clear below is token-guarded so a concurrent takeover is never clobbered.
  const subscriptionId = candidate.stripe_subscription_id?.trim();
  if (subscriptionId) {
    try {
      await getStripe().subscriptions.update(
        subscriptionId,
        { cancel_at_period_end: true },
        { idempotencyKey: reactivationCompensateIdempotencyKey(candidate.id, candidate.account_id, token) },
      );
    } catch (err) {
      if (isRetryableStripeError(err)) {
        logger.log('Deferring reset - retryable Stripe error', { offboarding_id: candidate.id });
        return false;
      }
      // Permanent error (e.g. subscription already gone): nothing to restore,
      // fall through and release the stranded claim.
      logger.log('Stripe compensation permanent error - releasing claim anyway', { offboarding_id: candidate.id });
    }
  }

  // 2) Release the claim, guarded by the observed token so a takeover or a
  //    late-finalizing original reactivation is never overwritten.
  return sql.begin(async (tx) => {
    const [cleared] = await tx<{ id: string }[]>`
      UPDATE account_offboardings
      SET reactivation_claimed_at = NULL,
          reactivation_claim_token = NULL,
          updated_at = NOW()
      WHERE id = ${candidate.id}::uuid
        AND account_id = ${candidate.account_id}::uuid
        AND mode = 'cancel_only'
        AND status = 'scheduled'
        AND terminal_at IS NULL
        AND reactivated_at IS NULL
        AND reactivation_claimed_at IS NOT NULL
        AND reactivation_claim_token = ${token}
      RETURNING id
    `;

    if (!cleared) {
      logger.log('Skipped - claim changed before reset', { offboarding_id: candidate.id });
      return false;
    }

    await writeAccountAuditLog(
      {
        accountId: candidate.account_id,
        eventType: 'account_offboarding_reactivation_claim_reset',
        entityType: 'account_offboarding',
        entityId: candidate.id,
        payload: {
          mode: 'cancel_only',
          status: 'scheduled',
          reason: 'stale_reactivation_claim',
        },
      },
      tx,
    );

    return true;
  });
}

function reactivationCompensateIdempotencyKey(
  offboardingId: string,
  accountId: string,
  token: string,
): string {
  return ['account-offboarding-reactivate-compensate', offboardingId, accountId, token].join(':');
}

function isRetryableStripeError(err: unknown): boolean {
  const error = err as { type?: unknown; statusCode?: unknown };
  const type = typeof error.type === 'string' ? error.type : '';
  if (
    type === 'StripeAPIConnectionError'
    || type === 'StripeConnectionError'
    || type === 'StripeAPIError'
    || type === 'StripeRateLimitError'
  ) {
    return true;
  }
  const statusCode = typeof error.statusCode === 'number' ? error.statusCode : null;
  if (statusCode !== null) return statusCode === 429 || statusCode >= 500;
  return false;
}

export function startAccountOffboardingReactivationResetPoller(): void {
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
  runAccountOffboardingReactivationResetOnce().catch(logUnhandledPollError(LOG_PREFIX));
  pollerInterval = setInterval(() => {
    runAccountOffboardingReactivationResetOnce().catch(logUnhandledPollError(LOG_PREFIX));
  }, intervalMs);
}

export function stopAccountOffboardingReactivationResetPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    createWorkerLogger(LOG_PREFIX).log('Stopped');
  }
}
