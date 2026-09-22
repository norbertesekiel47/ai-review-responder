import type { Job } from 'bullmq';
import type postgres from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  errorMessage,
  extractOutboxHandle,
  isTerminalAttempt,
  markOutboxCompleted,
  markOutboxFailed,
} from '../../../src/lib/shared/outbox';
import type { AccountOffboardingPurgePayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import {
  type AccountOffboardingPurgeRow,
  finalizePurgeInTransaction,
  isStaleOutboxAttemptError,
  loadPurgeOffboarding,
  markPurgeRetryableFailure,
  markPurgeTerminalFailure,
  runAnalyticsPurgeStage,
  runAuditAndCostPayloadPurgeStage,
  runAuthBindingPurgeStage,
  runContentPurgeStage,
  runDependentReferencePurgeStage,
  runParentTombstonePurgeStage,
  runProviderIdentifierPurgeStage,
  runRawPayloadPurgeStage,
  runStripeCustomerRedactionPurgeStage,
  validatePurgeableOffboarding,
} from './purge-stages';
import { scrubOffboardingErrorForStorage } from '../../../src/lib/account-offboarding/scrub-error';
import { getStripe } from '../../../src/lib/payments/stripe-client';
import { alertOffboardingFailure, OFFBOARDING_NOT_FOUND } from './failure-alert';

export async function handleAccountOffboardingPurge(
  sql: postgres.Sql,
  supabaseServer: SupabaseClient,
  job: Job<AccountOffboardingPurgePayload>,
): Promise<void> {
  const logger = createWorkerLogger(
    '[AccountOffboardingPurgeWorker]',
    job.data.correlation_id,
  );
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // The load sits in its own try so a throw here still reaches rule 16 under
  // the offboarding's own fingerprint (#1413). Left outside any try, it
  // surfaced only as an `attachJobFailureSink` `captureException` on the
  // exhausted attempt — an event rule 11's `queue = agent_turn` filter excludes
  // and nothing else routes.
  let offboarding: AccountOffboardingPurgeRow | null;
  try {
    offboarding = await loadPurgeOffboarding(
      sql,
      job.data.account_offboarding_id,
      job.data.account_id,
    );
  } catch (err) {
    const safeMessage = scrubOffboardingErrorForStorage(errorMessage(err));
    logger.error(
      `Purge load failed for offboarding ${job.data.account_offboarding_id}: ${safeMessage}`,
    );
    if (!isTerminalAttempt(job)) {
      alertPurgeFailure(job.data, safeMessage, false);
      throw new Error(safeMessage);
    }
    // No loaded row to hand over, so the terminal marks go by the payload's
    // ids — landing the SAME `failed` / `failed_step='purge'` state every other
    // terminal purge failure lands, which is the state #1411's recovery targets.
    await markPurgeTerminalFailure(
      sql,
      { id: job.data.account_offboarding_id, account_id: job.data.account_id },
      safeMessage,
    );
    await markOutboxFailed(sql, outboxId, safeMessage, outboxAttempt);
    alertPurgeFailure(job.data, safeMessage, true);
    return;
  }

  if (!offboarding) {
    // Absence does not prove there is no DELETION obligation (#1413): the
    // event goes out terminal, under the id the job was dispatched for.
    await markOutboxFailed(sql, outboxId, OFFBOARDING_NOT_FOUND, outboxAttempt);
    alertPurgeFailure(job.data, OFFBOARDING_NOT_FOUND, true);
    return;
  }

  if (offboarding.status === 'purged' || offboarding.terminal_at !== null) {
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  const validationError = validatePurgeableOffboarding(offboarding);
  if (validationError) {
    const safeMessage = scrubOffboardingErrorForStorage(validationError);
    // Durable marks first, alert after: the alert is best-effort work behind
    // the side effect it reports (`.claude/rules/worker-layout.md`).
    if (!isTerminalAttempt(job)) {
      await markPurgeRetryableFailure(sql, offboarding, safeMessage);
      alertPurgeFailure(job.data, safeMessage, false);
      throw new Error(safeMessage);
    }
    await markPurgeTerminalFailure(sql, offboarding, safeMessage);
    await markOutboxFailed(sql, outboxId, safeMessage, outboxAttempt);
    alertPurgeFailure(job.data, safeMessage, true);
    return;
  }

  try {
    // Purge stages are strictly ordered (auth → refs → payload → content → … → tombstone →
    // finalize); each is its own transaction taking FOR UPDATE locks on the shared accounts row,
    // so running them in parallel would deadlock and violate the dependency ordering.
    // react-doctor-disable-next-line react-doctor/async-parallel
    //
    // THE STRIPE CALL RUNS FIRST — this INVERTS the original D5 and the reason
    // is worth stating, because D5's own rationale was false.
    //
    // D5 placed redaction immediately before the tombstone, arguing that by
    // then "every local destruction has committed, so the point of no return
    // has passed". The async and database review axes both showed that is
    // untrue: runParentTombstonePurgeStage — the stage that actually replaces
    // names, emails, phones and addresses with sentinels — runs AFTER. So a
    // Stripe outage that exhausted retries left auth deleted and content
    // destroyed while users/businesses/accounts still held live PII, with the
    // offboarding terminal, no receipt, and no automatic re-run.
    //
    // Running first restores fail-fast: a Stripe failure aborts with NOTHING
    // destroyed, and BullMQ retries the whole job cleanly.
    //
    // The hazard D5 feared — a LIVE account left with a wiped billing contact —
    // is not reachable here. An offboarding at this point has `purge_started_at`
    // set, and cancellation is gated on `purge_started_at IS NULL`
    // (`keep-my-data.ts`), so the account cannot return to service. The
    // shared-customer guard, not the ordering, is what protects a co-tenant.
    //
    // The worker resolves the client at its own boundary and passes it down —
    // the domain module never imports the singleton (invariant #15).
    await runStripeCustomerRedactionPurgeStage(sql, getStripe, offboarding);
    await runAuthBindingPurgeStage(sql, supabaseServer, offboarding);
    await runDependentReferencePurgeStage(sql, offboarding);
    await runRawPayloadPurgeStage(sql, offboarding, outboxId);
    await runContentPurgeStage(sql, offboarding);
    await runAnalyticsPurgeStage(sql, offboarding);
    await runProviderIdentifierPurgeStage(sql, offboarding);
    await runAuditAndCostPayloadPurgeStage(sql, offboarding);
    await runParentTombstonePurgeStage(sql, offboarding);

    // finalizePurgeInTransaction enqueues the purge-receipt email durably inside
    // its transaction (see M2), so there is no best-effort post-commit send to
    // lose on a crash.
    await finalizePurgeInTransaction(sql, offboarding, outboxId, outboxAttempt);
  } catch (err) {
    if (isStaleOutboxAttemptError(err)) {
      logger.log(`Skipping stale purge outbox attempt for offboarding ${offboarding.id}`);
      return;
    }

    const safeMessage = scrubOffboardingErrorForStorage(errorMessage(err));
    logger.error(`Purge failed for offboarding ${offboarding.id}: ${safeMessage}`);
    if (!isTerminalAttempt(job)) {
      await markPurgeRetryableFailure(sql, offboarding, safeMessage);
      alertPurgeFailure(job.data, safeMessage, false);
      throw new Error(safeMessage);
    }

    await markPurgeTerminalFailure(sql, offboarding, safeMessage);
    await markOutboxFailed(sql, outboxId, safeMessage, outboxAttempt);
    alertPurgeFailure(job.data, safeMessage, true);
  }
}

/** Rule 16 (`docs/runbooks/beta-launch-alerting.md`): grouping and levels live in `failure-alert.ts`. */
function alertPurgeFailure(
  payload: AccountOffboardingPurgePayload,
  safeMessage: string,
  terminal: boolean,
): void {
  alertOffboardingFailure({
    step: 'purge',
    accountOffboardingId: payload.account_offboarding_id,
    accountId: payload.account_id,
    safeMessage,
    terminal,
  });
}
