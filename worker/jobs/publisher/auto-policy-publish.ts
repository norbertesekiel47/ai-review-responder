import type { Sql, TransactionSql } from 'postgres';
import { acquireTierEntitlementLock } from '../../../src/lib/accounts/billing-locks';
import { SubscriptionTier } from '../../../src/lib/accounts/tier-config';
import { autoApprovalRuntimeEnabled } from '../../../src/lib/auto-approval/flags';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import { AUDIT_ACTION_AUTO_APPROVED_BY_POLICY } from '../../../src/lib/approval/audit';
import { revokeOpenLinksForResponse } from '../../../src/lib/approval/locks';
import {
  getTransactionalReviewPublisher,
  type ReviewPublisher,
} from '../../../src/lib/publishing/review-publisher';
import type {
  ResolvedPublishTarget,
  ResolveTargetResult,
} from '../../../src/lib/publishing/review-publisher';
import {
  getOffboardingState,
  isPublishingBlocked,
} from '../../../src/lib/account-offboarding/gate';
import { checkSubscription, type AccountFlagsInput } from '../../../src/lib/shared/subscription-guard';
import { markOutboxCompletedIfOwned } from '../../../src/lib/shared/outbox';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioReplyAlreadyExistsError,
  ZernioTransientError,
  ZernioValidationError,
} from '../../../src/lib/zernio/errors';
import { maybeCaptureActivationCompleted } from './activation';
import {
  downgradeAutoApprovedResponseForManualReviewInTx,
} from './auto-policy-downgrade';
import { isHeldForModerationReviewInTx } from './held-flag-gate';
import { applyJudgeGateInTx } from './judge-gate';
import {
  markPostedAndMaybeEnqueueAutoPostNotice,
  recoverAutoPolicyProviderTruth,
} from './mark-posted';
import { parkResponseForOwnerReconnectInTx } from './no-connection';
import {
  handlePublisherAuthErrorTerminalInTx,
  handlePublisherPermanentErrorTerminalInTx,
  PublisherTransientWithContext,
  verify409InTx,
  ZernioReplyVerificationIndeterminateError,
} from './publisher-error-handlers';
import { openReviewNotFoundExceptionInTx } from './review-lookup';
import { enforceElapsedVetoWindowInTx } from './veto-window-gate';
import { verifyOwnReplyAttached } from './verify-posted';

const PROVIDER_ATTEMPT_MARKER = '_auto_policy_provider_attempt';

type ProviderAttemptMarker =
  | { phase: 'none' }
  | { phase: 'armed' }
  | {
      phase: 'possible';
      locator: ResolvedPublishTarget['locator'];
    };

interface AutoPolicyPublishInput {
  responseId: string;
  reviewId: string;
  businessId: string;
  accountId: string;
  approvedText: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  correlationId: string | undefined;
  logger: WorkerLogger;
}

export async function hasAutoPolicyProviderAttemptMarker(
  sql: Sql,
  input: { outboxId: string; outboxAttempt: number | undefined },
): Promise<boolean> {
  const [row] = input.outboxAttempt === undefined
    ? await sql<{ present: boolean }[]>`
        SELECT payload ? ${PROVIDER_ATTEMPT_MARKER} AS present
        FROM job_outbox
        WHERE id = ${input.outboxId}::uuid
          AND status = 'dispatched'
      `
    : await sql<{ present: boolean }[]>`
        SELECT payload ? ${PROVIDER_ATTEMPT_MARKER} AS present
        FROM job_outbox
        WHERE id = ${input.outboxId}::uuid
          AND status = 'dispatched'
          AND attempts = ${input.outboxAttempt}
      `;
  return row?.present === true;
}

interface LockedLane {
  business: { id: string; account_id: string; archived_at: Date | null };
  response: {
    id: string;
    status: string;
    approval_method: string | null;
    approved_text: string | null;
  };
  entitlement: {
    subscription_status: string;
    subscription_tier: string;
    past_due_at: Date | null;
    flags: AccountFlagsInput | null;
  };
  providerAttempt: ProviderAttemptMarker;
}

type GateOutcome = 'continue' | 'completed';
type InitialPhaseOutcome = 'completed' | 'posted' | 'armed' | 'prepare';
type PreparationOutcome =
  | { kind: 'completed' }
  | { kind: 'created_possible' }
  | { kind: 'observed_possible' };
type FinalPhaseOutcome =
  | 'completed'
  | 'posted'
  | { kind: 'retry'; error: unknown };

/**
 * Auto-policy's provider lane uses a durable three-phase protocol:
 *
 *  1. lock/revalidate every safety gate, persist marker phase `armed`, commit;
 *  2. reacquire, revalidate, resolve a target, persist phase `possible` with
 *     its non-secret locator, commit;
 *  3. reacquire, revalidate, CAS-complete, then post/verify and mutate domain
 *     state atomically.
 *
 * `armed` proves no provider call was possible, so retry may safely resume
 * gates/resolve or downgrade. `possible` is committed before the provider call;
 * any later retry reconciles provider truth before considering local state.
 * The payload marker survives last_error writes and watchdog redispatch.
 */
export async function publishAutoPolicyResponse(
  sql: Sql,
  input: AutoPolicyPublishInput,
): Promise<void> {
  const initial = await sql.begin(async (tx): Promise<InitialPhaseOutcome> => {
    const lane = await lockLane(tx, input);
    if (!lane) {
      await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt);
      return 'completed';
    }

    // Only `possible` means a provider call may have happened. Reconcile it
    // before ANY runtime, tier, archive, moderation, or Judge decision.
    if (lane.providerAttempt.phase === 'possible') {
      return reconcilePriorProviderAttempt(sql, tx, input, lane);
    }

    if (!isPublishableAutoPolicy(lane.response)) {
      await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt);
      return 'completed';
    }

    const gate = await evaluateLockedGates(tx, input, lane);
    if (gate !== 'continue') return gate;

    if (lane.providerAttempt.phase === 'armed') return 'prepare';
    return await armProviderAttempt(tx, input) ? 'armed' : 'completed';
  });

  if (initial === 'completed') return;
  if (initial === 'posted') {
    await afterPosted(sql, input);
    return;
  }

  const preparation = await sql.begin(async (tx): Promise<PreparationOutcome> => {
    const lane = await lockLane(tx, input);
    if (!lane) return { kind: 'completed' };
    // Another stalled/overlapping invocation may have won armed -> possible.
    // Only that CAS winner may enter the fresh provider-call phase. An observer
    // must reconcile the durable locator because the winner may already have
    // called the provider and rolled its outcome transaction back.
    if (lane.providerAttempt.phase === 'possible') {
      return { kind: 'observed_possible' };
    }
    if (lane.providerAttempt.phase !== 'armed') return { kind: 'completed' };
    if (!isPublishableAutoPolicy(lane.response)) {
      await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt);
      return { kind: 'completed' };
    }

    const gate = await evaluateLockedGates(tx, input, lane);
    if (gate !== 'continue') return { kind: 'completed' };

    const resolution = await getTransactionalReviewPublisher(tx).resolveTarget({
      responseId: input.responseId,
      reviewId: input.reviewId,
      businessId: input.businessId,
    });
    if (resolution.kind === 'transient') throw transientFor(input, resolution);
    if (resolution.kind === 'no_connection') {
      if (!await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt)) {
        return { kind: 'completed' };
      }
      await parkResponseForOwnerReconnectInTx(tx, {
        ...input,
        responseStatus: lane.response.status,
      });
      return { kind: 'completed' };
    }
    if (resolution.kind === 'review_not_found') {
      if (!await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt)) {
        return { kind: 'completed' };
      }
      await openReviewNotFoundExceptionInTx(tx, {
        ...input,
        errorMeta: resolution.meta,
      });
      return { kind: 'completed' };
    }

    const marked = await markProviderAttemptPossible(tx, input, resolution.target);
    return { kind: marked ? 'created_possible' : 'completed' };
  });
  if (preparation.kind === 'completed') return;
  if (preparation.kind === 'observed_possible') {
    const reconciled = await sql.begin(async (tx): Promise<'completed' | 'posted'> => {
      const lane = await lockLane(tx, input);
      if (!lane || lane.providerAttempt.phase !== 'possible') return 'completed';
      return reconcilePriorProviderAttempt(sql, tx, input, lane);
    });
    if (reconciled === 'posted') await afterPosted(sql, input);
    return;
  }

  const published = await sql.begin(async (tx): Promise<FinalPhaseOutcome> => {
    const lane = await lockLane(tx, input);
    if (!lane || lane.providerAttempt.phase !== 'possible') return 'completed';
    if (!isPublishableAutoPolicy(lane.response)) {
      await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt);
      return 'completed';
    }

    const gate = await evaluateLockedGates(tx, input, lane);
    if (gate !== 'continue') return gate;

    // Re-resolve inside the final outcome transaction. Phase two's locator is
    // only the durable ambiguity anchor; it is never trusted as current after
    // releasing that transaction's locks. The transactional adapter locks the
    // active connection row through the provider call and outcome commit.
    const publisher = getTransactionalReviewPublisher(tx);
    let resolution: ResolveTargetResult;
    try {
      resolution = await publisher.resolveTarget({
        responseId: input.responseId,
        reviewId: input.reviewId,
        businessId: input.businessId,
      });
    } catch (error) {
      // Auth/permanent/unknown resolution failures happen before publishReply.
      // Persist the safe `armed` state, then rethrow outside this transaction;
      // throwing here would roll back the reset and create false ambiguity.
      if (!await resetProviderAttemptToArmed(tx, input)) return 'completed';
      return { kind: 'retry', error };
    }

    // Target resolution may include a bounded provider lookup. Recheck the
    // independently-written offboarding projection immediately afterward so
    // an offboarding that began during resolution still prevents the call.
    if (await completeIfPublishingOffboarded(tx, input, lane.business.account_id)) {
      return 'completed';
    }

    if (resolution.kind === 'transient') {
      if (!await resetProviderAttemptToArmed(tx, input)) return 'completed';
      return { kind: 'retry', error: transientFor(input, resolution) };
    }
    if (resolution.kind === 'no_connection') {
      if (!await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt)) {
        return 'completed';
      }
      await parkResponseForOwnerReconnectInTx(tx, {
        ...input,
        responseStatus: lane.response.status,
      });
      return 'completed';
    }
    if (resolution.kind === 'review_not_found') {
      if (!await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt)) {
        return 'completed';
      }
      await openReviewNotFoundExceptionInTx(tx, {
        ...input,
        errorMeta: resolution.meta,
      });
      return 'completed';
    }

    if (!sameLocator(lane.providerAttempt.locator, resolution.target.locator)) {
      if (!await resetProviderAttemptToArmed(tx, input)) return 'completed';
      return {
        kind: 'retry',
        error: targetChangedTransient(input, resolution.target),
      };
    }

    // Claim the attempt before provider work: auth/permanent, 409, and fresh
    // post mutations all roll back together if anything later throws. A CAS
    // loser performs zero provider calls/writes.
    if (!await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt)) {
      return 'completed';
    }

    return publishUnderClaim(
      sql,
      tx,
      input,
      lane,
      resolution.target,
      publisher,
    );
  });

  if (typeof published === 'object') throw published.error;
  if (published === 'posted') await afterPosted(sql, input);
}

async function lockLane(
  tx: TransactionSql,
  input: AutoPolicyPublishInput,
): Promise<LockedLane | null> {
  const [review] = await tx<{ id: string }[]>`
    SELECT id
    FROM reviews
    WHERE id = ${input.reviewId}::uuid
      AND business_id = ${input.businessId}::uuid
    FOR UPDATE
  `;
  if (!review) return null;

  const [business] = await tx<LockedLane['business'][]>`
    SELECT id, account_id, archived_at
    FROM businesses
    WHERE id = ${input.businessId}::uuid
      AND account_id = ${input.accountId}::uuid
    FOR UPDATE
  `;
  if (!business) return null;

  const [response] = await tx<LockedLane['response'][]>`
    SELECT id, status, approval_method, approved_text
    FROM responses
    WHERE id = ${input.responseId}::uuid
      AND business_id = ${input.businessId}::uuid
      AND review_id = ${input.reviewId}::uuid
    FOR UPDATE
  `;
  if (!response) return null;

  await acquireTierEntitlementLock(tx, business.account_id);
  const [entitlement] = await tx<LockedLane['entitlement'][]>`
    SELECT subscription_status, subscription_tier, past_due_at, flags
    FROM accounts
    WHERE id = ${business.account_id}::uuid
  `;
  if (!entitlement) return null;

  type MarkerRow = {
    phase: string | null;
    provider_account_id: string | null;
    provider_location_id: string | null;
    provider_review_id: string | null;
  };
  const [outbox] = input.outboxAttempt === undefined
    ? await tx<MarkerRow[]>`
        SELECT
          payload->${PROVIDER_ATTEMPT_MARKER}->>'phase' AS phase,
          payload->${PROVIDER_ATTEMPT_MARKER}->'locator'->>'account_id' AS provider_account_id,
          payload->${PROVIDER_ATTEMPT_MARKER}->'locator'->>'location_id' AS provider_location_id,
          payload->${PROVIDER_ATTEMPT_MARKER}->'locator'->>'provider_review_id' AS provider_review_id
        FROM job_outbox
        WHERE id = ${input.outboxId}::uuid
          AND status = 'dispatched'
        FOR UPDATE
      `
    : await tx<MarkerRow[]>`
        SELECT
          payload->${PROVIDER_ATTEMPT_MARKER}->>'phase' AS phase,
          payload->${PROVIDER_ATTEMPT_MARKER}->'locator'->>'account_id' AS provider_account_id,
          payload->${PROVIDER_ATTEMPT_MARKER}->'locator'->>'location_id' AS provider_location_id,
          payload->${PROVIDER_ATTEMPT_MARKER}->'locator'->>'provider_review_id' AS provider_review_id
        FROM job_outbox
        WHERE id = ${input.outboxId}::uuid
          AND status = 'dispatched'
          AND attempts = ${input.outboxAttempt}
        FOR UPDATE
      `;
  if (!outbox) return null;

  let providerAttempt: ProviderAttemptMarker = { phase: 'none' };
  if (outbox.phase === 'armed') {
    providerAttempt = { phase: 'armed' };
  } else if (outbox.phase === 'possible') {
    if (
      !outbox.provider_account_id
      || !outbox.provider_location_id
      || !outbox.provider_review_id
    ) {
      throw new Error('possible provider-attempt marker is missing its locator');
    }
    providerAttempt = {
      phase: 'possible',
      locator: {
        accountId: outbox.provider_account_id,
        locationId: outbox.provider_location_id,
        providerReviewId: outbox.provider_review_id,
      },
    };
  } else if (outbox.phase !== null) {
    throw new Error(`unknown provider-attempt marker phase: ${outbox.phase}`);
  }

  return {
    business,
    response,
    entitlement,
    providerAttempt,
  };
}

function isPublishableAutoPolicy(response: LockedLane['response']): boolean {
  return ['approved', 'edited', 'awaiting_owner_connect'].includes(response.status)
    && response.approval_method === APPROVAL_METHOD.AUTO_POLICY;
}

async function evaluateLockedGates(
  tx: TransactionSql,
  input: AutoPolicyPublishInput,
  lane: LockedLane,
): Promise<GateOutcome> {
  if (await completeIfPublishingOffboarded(tx, input, lane.business.account_id)) {
    return 'completed';
  }

  if (!autoApprovalRuntimeEnabled()) {
    await downgradeAutoApprovedResponseForManualReviewInTx(tx, {
      ...input,
      reason: 'auto_approval_disabled',
    });
    return 'completed';
  }

  const veto = await enforceElapsedVetoWindowInTx(tx, input);
  if (veto === 'downgrade') {
    await downgradeAutoApprovedResponseForManualReviewInTx(tx, {
      ...input,
      reason: 'notice_undelivered',
    });
    return 'completed';
  }
  if (veto === 'completed') return 'completed';

  if (lane.business.archived_at !== null) {
    await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt);
    return 'completed';
  }

  const subscription = checkSubscription({
    status: lane.entitlement.subscription_status,
    pastDueAt: lane.entitlement.past_due_at,
    accountFlags: lane.entitlement.flags ?? {},
    workerType: 'publisher',
  });
  if (
    !subscription.allowed
    || lane.entitlement.subscription_tier !== SubscriptionTier.AUTOPILOT
  ) {
    await downgradeAutoApprovedResponseForManualReviewInTx(tx, {
      ...input,
      reason: 'autopilot_entitlement_lost',
    });
    return 'completed';
  }

  if (await isHeldForModerationReviewInTx(tx, input.responseId)) {
    await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt);
    return 'completed';
  }

  const judge = await applyJudgeGateInTx(tx, input);
  return judge === 'post' ? 'continue' : 'completed';
}

async function completeIfPublishingOffboarded(
  tx: TransactionSql,
  input: AutoPolicyPublishInput,
  accountId: string,
): Promise<boolean> {
  const offboarding = await getOffboardingState(accountId, tx);
  if (!isPublishingBlocked(offboarding)) return false;
  await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt);
  return true;
}

async function armProviderAttempt(
  tx: TransactionSql,
  input: AutoPolicyPublishInput,
): Promise<boolean> {
  const marker = tx.json({
    [PROVIDER_ATTEMPT_MARKER]: {
      phase: 'armed',
      armed_at: new Date().toISOString(),
      outbox_attempt: input.outboxAttempt,
    },
  } as never);
  const armed = input.outboxAttempt === undefined
    ? await tx`
        UPDATE job_outbox
        SET payload = COALESCE(payload, '{}'::jsonb) || ${marker}
        WHERE id = ${input.outboxId}::uuid
          AND status = 'dispatched'
      `
    : await tx`
        UPDATE job_outbox
        SET payload = COALESCE(payload, '{}'::jsonb) || ${marker}
        WHERE id = ${input.outboxId}::uuid
          AND status = 'dispatched'
          AND attempts = ${input.outboxAttempt}
      `;
  return armed.count > 0;
}

async function markProviderAttemptPossible(
  tx: TransactionSql,
  input: AutoPolicyPublishInput,
  target: ResolvedPublishTarget,
): Promise<boolean> {
  const marker = tx.json({
    [PROVIDER_ATTEMPT_MARKER]: {
      phase: 'possible',
      possible_at: new Date().toISOString(),
      outbox_attempt: input.outboxAttempt,
      locator: {
        account_id: target.locator.accountId,
        location_id: target.locator.locationId,
        provider_review_id: target.locator.providerReviewId,
      },
    },
  } as never);
  const marked = input.outboxAttempt === undefined
    ? await tx`
        UPDATE job_outbox
        SET payload = COALESCE(payload, '{}'::jsonb) || ${marker}
        WHERE id = ${input.outboxId}::uuid
          AND status = 'dispatched'
          AND payload->${PROVIDER_ATTEMPT_MARKER}->>'phase' = 'armed'
      `
    : await tx`
        UPDATE job_outbox
        SET payload = COALESCE(payload, '{}'::jsonb) || ${marker}
        WHERE id = ${input.outboxId}::uuid
          AND status = 'dispatched'
          AND attempts = ${input.outboxAttempt}
          AND payload->${PROVIDER_ATTEMPT_MARKER}->>'phase' = 'armed'
      `;
  return marked.count > 0;
}

async function resetProviderAttemptToArmed(
  tx: TransactionSql,
  input: AutoPolicyPublishInput,
): Promise<boolean> {
  const marker = tx.json({
    [PROVIDER_ATTEMPT_MARKER]: {
      phase: 'armed',
      armed_at: new Date().toISOString(),
      outbox_attempt: input.outboxAttempt,
      reset_reason: 'publish_target_revalidation',
    },
  } as never);
  const reset = input.outboxAttempt === undefined
    ? await tx`
        UPDATE job_outbox
        SET payload = COALESCE(payload, '{}'::jsonb) || ${marker}
        WHERE id = ${input.outboxId}::uuid
          AND status = 'dispatched'
          AND payload->${PROVIDER_ATTEMPT_MARKER}->>'phase' = 'possible'
      `
    : await tx`
        UPDATE job_outbox
        SET payload = COALESCE(payload, '{}'::jsonb) || ${marker}
        WHERE id = ${input.outboxId}::uuid
          AND status = 'dispatched'
          AND attempts = ${input.outboxAttempt}
          AND payload->${PROVIDER_ATTEMPT_MARKER}->>'phase' = 'possible'
      `;
  return reset.count > 0;
}

function sameLocator(
  left: ResolvedPublishTarget['locator'],
  right: ResolvedPublishTarget['locator'],
): boolean {
  return left.accountId === right.accountId
    && left.locationId === right.locationId
    && left.providerReviewId === right.providerReviewId;
}

function targetChangedTransient(
  input: AutoPolicyPublishInput,
  target: ResolvedPublishTarget,
): PublisherTransientWithContext {
  return new PublisherTransientWithContext(
    new ZernioTransientError('publish_target_changed_during_attempt', {}),
    {
      response_id: input.responseId,
      business_id: input.businessId,
      account_id: target.locator.accountId,
      location_id: target.locator.locationId,
    },
  );
}

function targetFromMarker(
  input: AutoPolicyPublishInput,
  marker: Extract<ProviderAttemptMarker, { phase: 'possible' }>,
): ResolvedPublishTarget {
  return {
    ref: {
      responseId: input.responseId,
      reviewId: input.reviewId,
      businessId: input.businessId,
    },
    locator: marker.locator,
  };
}

async function publishUnderClaim(
  sql: Sql,
  tx: TransactionSql,
  input: AutoPolicyPublishInput,
  lane: LockedLane,
  target: ResolvedPublishTarget,
  publisher: ReviewPublisher,
): Promise<'completed' | 'posted'> {
  const approvedText = lane.response.approved_text ?? input.approvedText;
  try {
    await publisher.publishReply(target.locator, approvedText);
  } catch (error) {
    if (error instanceof ZernioReplyAlreadyExistsError) {
      return disposeVerifiedReply(sql, tx, input, target, approvedText);
    }
    if (error instanceof ZernioAuthError) {
      await handlePublisherAuthErrorTerminalInTx(tx, authArgs(input, target, error));
      return 'completed';
    }
    if (error instanceof ZernioPermanentError || error instanceof ZernioValidationError) {
      await handlePublisherPermanentErrorTerminalInTx(
        tx,
        permanentArgs(input, error),
      );
      return 'completed';
    }
    if (error instanceof ZernioTransientError) {
      throw transientFor(input, {
        kind: 'transient',
        accountId: target.locator.accountId,
        locationId: target.locator.locationId,
        error,
      });
    }
    throw error;
  }

  // A 2xx can still be ambiguous. Failure rolls back completion/domain state,
  // while the phase-A payload marker remains committed for reconciliation.
  await verifyOwnReplyAttached(sql, { target, approvedText, logger: input.logger });
  const posted = await markPostedAndMaybeEnqueueAutoPostNotice({
    tx,
    responseId: input.responseId,
    reviewId: input.reviewId,
    businessId: input.businessId,
    correlationId: input.correlationId,
    logger: input.logger,
  });
  if (!posted.transitioned) {
    throw new Error(`Provider accepted reply but response ${input.responseId} did not transition`);
  }
  return 'posted';
}

async function reconcilePriorProviderAttempt(
  sql: Sql,
  tx: TransactionSql,
  input: AutoPolicyPublishInput,
  lane: LockedLane,
): Promise<'completed' | 'posted'> {
  if (!await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt)) {
    return 'completed';
  }
  if (lane.providerAttempt.phase !== 'possible') {
    throw new Error('provider truth reconciliation requires a possible marker');
  }
  const target = targetFromMarker(input, lane.providerAttempt);
  const [approval] = await tx<{
    response_text_at_approval: string;
    approved_at: Date;
  }[]>`
    SELECT response_text_at_approval, created_at AS approved_at
    FROM approval_audit_log
    WHERE response_id = ${input.responseId}::uuid
      AND business_id = ${input.businessId}::uuid
      AND action = ${AUDIT_ACTION_AUTO_APPROVED_BY_POLICY}
      AND response_text_at_approval IS NOT NULL
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `;
  if (!approval) {
    throw priorAttemptIndeterminate(input, 'approval_audit_missing', target);
  }
  const approvedText = approval.response_text_at_approval;
  const verified = await verify409InTx(sql, {
    tx,
    account_id: target.locator.accountId,
    location_id: target.locator.locationId,
    zernio_review_id: target.locator.providerReviewId,
    approved_text: approvedText,
    logger: input.logger,
  });

  if (verified.disposition === 'matches_our_text') {
    await recoverAutoPolicyProviderTruth({
      tx,
      responseId: input.responseId,
      reviewId: input.reviewId,
      businessId: input.businessId,
      approvedText,
      approvedAt: approval.approved_at,
      correlationId: input.correlationId,
      logger: input.logger,
    });
    return 'posted';
  }
  if (verified.disposition === 'mismatch') {
    await supersedeProviderMismatch(tx, input);
    return 'completed';
  }
  if (verified.disposition === 'transient') {
    throw transientFor(input, {
      kind: 'transient',
      accountId: target.locator.accountId,
      locationId: target.locator.locationId,
      error: verified.lookupErr,
    });
  }
  if (verified.disposition === 'indeterminate') {
    throw new ZernioReplyVerificationIndeterminateError({
      response_id: input.responseId,
      business_id: input.businessId,
      review_id: input.reviewId,
      account_id: target.locator.accountId,
      location_id: target.locator.locationId,
      zernio_review_id: target.locator.providerReviewId,
      reason: verified.reason,
      ...verified.meta,
    });
  }
  throw priorAttemptIndeterminate(input, verified.disposition, target);
}

async function supersedeProviderMismatch(
  tx: TransactionSql,
  input: AutoPolicyPublishInput,
): Promise<void> {
  const superseded = await tx`
    UPDATE responses
    SET status = 'superseded',
        approval_method = NULL,
        approved_text = NULL,
        approved_at = NULL,
        auto_post_scheduled_at = NULL,
        posting_error = 'already_replied_external',
        updated_at = NOW()
    WHERE id = ${input.responseId}::uuid
      AND business_id = ${input.businessId}::uuid
      AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')
    RETURNING 1
  `;
  if (superseded.count !== 1) {
    throw new Error(
      `Confirmed provider mismatch could not supersede response ${input.responseId}`,
    );
  }
  await revokeOpenLinksForResponse(tx, input.responseId);
}

function priorAttemptIndeterminate(
  input: AutoPolicyPublishInput,
  underlying: string,
  target?: ResolvedPublishTarget,
): ZernioReplyVerificationIndeterminateError {
  return new ZernioReplyVerificationIndeterminateError({
    response_id: input.responseId,
    business_id: input.businessId,
    review_id: input.reviewId,
    account_id: target?.locator.accountId ?? 'unresolved',
    location_id: target?.locator.locationId ?? 'unresolved',
    zernio_review_id: target?.locator.providerReviewId ?? 'unresolved',
    reason: 'verifier_unknown_error',
    underlying_error: `prior_provider_attempt_${underlying}`.slice(0, 160),
  });
}

async function disposeVerifiedReply(
  sql: Sql,
  tx: TransactionSql,
  input: AutoPolicyPublishInput,
  target: ResolvedPublishTarget,
  approvedText: string,
): Promise<'completed' | 'posted'> {
  const verified = await verify409InTx(sql, {
    tx,
    account_id: target.locator.accountId,
    location_id: target.locator.locationId,
    zernio_review_id: target.locator.providerReviewId,
    approved_text: approvedText,
    logger: input.logger,
  });

  switch (verified.disposition) {
    case 'matches_our_text':
      {
        const posted = await markPostedAndMaybeEnqueueAutoPostNotice({
        tx,
        responseId: input.responseId,
        reviewId: input.reviewId,
        businessId: input.businessId,
        correlationId: input.correlationId,
        logger: input.logger,
        });
        if (!posted.transitioned) {
          throw new Error(
            `Confirmed provider reply but response ${input.responseId} did not transition`,
          );
        }
      }
      return 'posted';
    case 'mismatch':
      await supersedeProviderMismatch(tx, input);
      return 'completed';
    case 'transient':
      throw transientFor(input, {
        kind: 'transient',
        accountId: target.locator.accountId,
        locationId: target.locator.locationId,
        error: verified.lookupErr,
      });
    case 'auth':
    case 'permanent':
      if (verified.disposition === 'auth') {
        await handlePublisherAuthErrorTerminalInTx(
          tx,
          authArgs(input, target, verified.lookupErr),
        );
      } else {
        await handlePublisherPermanentErrorTerminalInTx(
          tx,
          permanentArgs(input, verified.lookupErr),
        );
      }
      return 'completed';
    case 'indeterminate':
      throw new ZernioReplyVerificationIndeterminateError({
        response_id: input.responseId,
        business_id: input.businessId,
        review_id: input.reviewId,
        account_id: target.locator.accountId,
        location_id: target.locator.locationId,
        zernio_review_id: target.locator.providerReviewId,
        reason: verified.reason,
        ...verified.meta,
      });
  }
}

function transientFor(
  input: AutoPolicyPublishInput,
  resolution: Extract<ResolveTargetResult, { kind: 'transient' }>,
): PublisherTransientWithContext {
  return new PublisherTransientWithContext(resolution.error, {
    response_id: input.responseId,
    business_id: input.businessId,
    account_id: resolution.accountId,
    location_id: resolution.locationId,
  });
}

function authArgs(
  input: AutoPolicyPublishInput,
  target: ResolvedPublishTarget,
  error: ZernioAuthError,
) {
  return {
    response_id: input.responseId,
    business_id: input.businessId,
    account_id: target.locator.accountId,
    location_id: target.locator.locationId,
    error_body: error.body ? String(error.body).slice(0, 500) : error.message,
    correlation_id: input.correlationId,
    logger: input.logger,
  };
}

function permanentArgs(
  input: AutoPolicyPublishInput,
  error: ZernioPermanentError | ZernioValidationError,
) {
  const endpointKind = error instanceof ZernioPermanentError
    && typeof error.meta?.endpointKind === 'string'
    ? error.meta.endpointKind
    : 'publish_reply';
  return {
    response_id: input.responseId,
    business_id: input.businessId,
    review_id: input.reviewId,
    endpoint_kind: endpointKind,
    http_status: 400,
    error_body: error instanceof ZernioPermanentError
      ? error.meta
      : { code: error.code, body: error.body },
    logger: input.logger,
  };
}

async function afterPosted(sql: Sql, input: AutoPolicyPublishInput): Promise<void> {
  input.logger.log(
    `Response ${input.responseId} posted via Zernio for business ${input.businessId}`,
  );
  await maybeCaptureActivationCompleted(sql, {
    responseId: input.responseId,
    businessId: input.businessId,
    reviewId: input.reviewId,
    logger: input.logger,
  });
}
