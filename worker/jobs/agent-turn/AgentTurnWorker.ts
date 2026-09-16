import { DelayedError, type Job } from 'bullmq';
import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { reauthorizeTurn } from '@/lib/agents/operator/authorize';
import { buildSnapshot } from '@/lib/agents/operator/context';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import { generateOperatorReply } from '@/lib/agents/operator/model-call';
import { readPolicySnapshot } from '@/lib/agents/operator/policy-state';
import {
  buildProposalRows,
  type PolicyPreparation,
  type PolicyPreparations,
  type UnsupportedRow,
} from '@/lib/agents/operator/proposals';
import { scrubPastedReview, type ParsedProposal } from '@/lib/agents/operator/render';
import { TURN_FAILURE_REASON } from '@/lib/agents/operator/schema';
import {
  claimTurn,
  completeTurnFenced,
  failTurnAndCompleteOutbox,
  failTurnFenced,
  isTerminalTurnStatus,
  loadPredecessor,
  readTerminalTurn,
  releaseTurnClaim,
  type ClaimedTurn,
  type TurnReplyPlan,
} from '@/lib/agents/operator/turns';
import { getAutoApprovalSettings } from '@/lib/auto-approval/settings';
import { readVoiceConfig } from '@/lib/responses/voice-settings';
import { createWorkerLogger } from '@/lib/shared/logger';
import { extractOutboxHandle, markOutboxCompletedIfOwned } from '@/lib/shared/outbox';
import type { AgentTurnPayload } from '@/lib/shared/worker-types';
import {
  AGENT_TURN_LEASE_SECONDS,
  AGENT_TURN_PREDECESSOR_STALL_SECONDS,
  AGENT_TURN_PREDECESSOR_WAIT_MS,
} from './constants';

const BUDGET_DECISION_ERROR_NAMES: readonly string[] = [
  'CostLimitExceededError',
  'GlobalCostLimitExceededError',
];

function isBudgetDecision(err: unknown): boolean {
  return err instanceof Error && BUDGET_DECISION_ERROR_NAMES.includes(err.name);
}

type WorkerLogger = ReturnType<typeof createWorkerLogger>;

/**
 * This dispatch's claim on the outbox row, threaded through every step so a
 * fenced transition and the row it settles always move together.
 */
interface OutboxHandle {
  outboxId: string;
  outboxAttempt: number | undefined;
}

/** Everything the fenced completion stores, assembled while the lease is held. */
interface AssembledTurn {
  replyPlan: TurnReplyPlan;
  proposals: ReturnType<typeof buildProposalRows>;
  unsupported: UnsupportedRow[];
  /** Model attempts spent, for the completion log line only. */
  attempts: number;
}

/**
 * The claim missed. Two very different reasons, and they need opposite handling.
 *
 * A live lease held elsewhere: exit without touching the outbox row, which
 * belongs to the holder.
 *
 * A turn that is ALREADY TERMINAL: the attempt that finished it completed a
 * DIFFERENT outbox attempt than this dispatch carries, so this row is still
 * `dispatched` and nothing else will ever move it. Left alone the watchdog
 * re-pends it forever against a turn that is finished. Complete it here.
 */
async function settleClaimMiss(
  sql: Sql,
  payload: AgentTurnPayload,
  outbox: OutboxHandle,
  logger: WorkerLogger,
): Promise<void> {
  const terminal = await readTerminalTurn(sql, {
    turnId: payload.turn_id,
    accountId: payload.account_id,
  });
  if (terminal) {
    logger.log('agent_turn already terminal, completing outbox', {
      turn_id: payload.turn_id,
      turn_status: terminal.status,
    });
    await markOutboxCompletedIfOwned(sql, outbox.outboxId, outbox.outboxAttempt);
    return;
  }
  logger.log('agent_turn claim not acquired', { turn_id: payload.turn_id });
}

/**
 * Step 2: the predecessor gate. Returns true when the turn has been FAILED and
 * the handler must stop; throws `DelayedError` when this turn must wait its
 * turn; returns false to proceed.
 */
async function waitOrFailOnPredecessor(
  sql: Sql,
  job: Job<AgentTurnPayload>,
  claimed: ClaimedTurn,
  outbox: OutboxHandle,
  logger: WorkerLogger,
): Promise<boolean> {
  const predecessor = claimed.sequence <= 1
    ? null
    : await loadPredecessor(sql, {
      conversationId: claimed.conversationId,
      accountId: claimed.accountId,
      sequence: claimed.sequence,
    });
  if (!predecessor || isTerminalTurnStatus(predecessor.status)) return false;

  if (predecessor.ageSeconds > AGENT_TURN_PREDECESSOR_STALL_SECONDS) {
    await failTurnFenced(sql, {
      turnId: claimed.turnId,
      accountId: claimed.accountId,
      attemptToken: claimed.attemptToken,
      reason: TURN_FAILURE_REASON.PREDECESSOR_STALLED,
      ...outbox,
    });
    logger.warn('agent_turn predecessor stalled', {
      turn_id: claimed.turnId,
      predecessor_age_seconds: predecessor.ageSeconds,
    });
    return true;
  }
  // Give the claim back and DELAY rather than throw: moveToDelayed +
  // DelayedError re-schedules the same job without consuming an attempt,
  // so a conversation with a slow first turn never exhausts its retry
  // budget waiting in line.
  const released = await releaseTurnClaim(sql, {
    turnId: claimed.turnId,
    accountId: claimed.accountId,
    attemptToken: claimed.attemptToken,
    leaseSeconds: AGENT_TURN_LEASE_SECONDS,
    refreshLiveness: true,
    ...outbox,
  });
  if (released !== 'released') return true;
  logger.log('agent_turn waiting on predecessor', {
    turn_id: claimed.turnId,
    sequence: claimed.sequence,
  });
  await job.moveToDelayed(Date.now() + AGENT_TURN_PREDECESSOR_WAIT_MS, job.token);
  throw new DelayedError();
}

/**
 * Steps 3–7: authorize again, scrub, snapshot, model, validate, map to rows.
 * Returns null when the turn has been FAILED (every such exit is fenced and
 * settles the outbox row itself) and the handler must stop.
 */
/**
 * The policy snapshot for each DISTINCT target the policy proposals name,
 * keyed the way `buildProposalRows` looks it up (location id, or null for the
 * account default). Each snapshot is one coherent read of values, tokens and
 * the review cohort; the model supplies none of it.
 *
 * `undefined` when there is no policy proposal, so a voice-only turn issues no
 * policy read. `null` when a target is missing or not this account's.
 */
async function preparePolicyTargets(
  sql: Sql,
  accountId: string,
  proposals: readonly ParsedProposal[],
): Promise<PolicyPreparations | null | undefined> {
  const targets = [...new Set(proposals.flatMap((proposal) =>
    proposal.operation.domain === 'policy' ? [proposal.scope.locationId ?? null] : []))];
  if (targets.length === 0) return undefined;

  const { readiness } = await getAutoApprovalSettings(sql, { accountId, impersonated: false });
  const preparations = new Map<string | null, PolicyPreparation>();
  for (const locationId of targets) {
    const snapshot = await readPolicySnapshot(sql, { accountId, locationId });
    if (snapshot === null) return null;
    preparations.set(locationId, { snapshot, blockReasons: readiness.blockReasons });
  }
  return preparations;
}

/** The fenced `unauthorized` failure every lost-scope exit shares. */
async function failTurnUnauthorized(
  sql: Sql,
  claimed: ClaimedTurn,
  outbox: OutboxHandle,
): Promise<void> {
  await failTurnFenced(sql, {
    turnId: claimed.turnId,
    accountId: claimed.accountId,
    attemptToken: claimed.attemptToken,
    reason: TURN_FAILURE_REASON.UNAUTHORIZED,
    ...outbox,
  });
}

async function generateAndAssemble(
  sql: Sql,
  claimed: ClaimedTurn,
  outbox: OutboxHandle,
  logger: WorkerLogger,
): Promise<AssembledTurn | null> {
  const authorized = await reauthorizeTurn(sql, {
    accountId: claimed.accountId,
    actorUserId: claimed.actorUserId,
    locationId: claimed.locationId,
  });
  if (!authorized.ok) {
    await failTurnFenced(sql, {
      turnId: claimed.turnId,
      accountId: claimed.accountId,
      attemptToken: claimed.attemptToken,
      reason: authorized.reason === 'account_offboarding'
        ? TURN_FAILURE_REASON.ACCOUNT_OFFBOARDING
        : TURN_FAILURE_REASON.UNAUTHORIZED,
      ...outbox,
    });
    logger.warn('agent_turn reauthorization failed', {
      turn_id: claimed.turnId,
      reason: authorized.reason,
    });
    return null;
  }

  const scrubbed = scrubPastedReview(claimed.ownerText);
  const snapshot = await buildSnapshot(sql, {
    accountId: claimed.accountId,
    locationId: claimed.locationId,
    locationName: authorized.locationName,
    conversationId: claimed.conversationId,
    sequence: claimed.sequence,
    subscriptionTier: authorized.subscriptionTier,
  });

  const generated = await generateOperatorReply(sql, {
    accountId: claimed.accountId,
    locationId: claimed.locationId,
    subscriptionTier: authorized.subscriptionTier,
    snapshot,
    ownerText: scrubbed.text,
    turnId: claimed.turnId,
  });
  if (!generated.ok) {
    await failTurnFenced(sql, {
      turnId: claimed.turnId,
      accountId: claimed.accountId,
      attemptToken: claimed.attemptToken,
      reason: TURN_FAILURE_REASON.MODEL_OUTPUT_INVALID,
      ...outbox,
    });
    logger.warn('agent_turn model output invalid', {
      turn_id: claimed.turnId,
      attempts: generated.attempts,
    });
    return null;
  }

  const voice = await readVoiceConfig(sql, {
    accountId: claimed.accountId,
    locationId: claimed.locationId,
  });
  if (!voice) {
    // The location vanished between step 3 and here — archived, or moved to
    // another account. That is an AUTHORIZATION change, not a mapping
    // detail: every proposal is prepared against this row's voice state and
    // its `updated_at` **Version token**, so there is nothing honest to
    // store. Failing here is what keeps the turn from completing with a
    // reply whose cards were all silently dropped.
    await failTurnUnauthorized(sql, claimed, outbox);
    logger.warn('agent_turn location voice row vanished after authorization', {
      turn_id: claimed.turnId,
    });
    return null;
  }

  // A policy target the reader cannot find is the same authorization change
  // as a vanished voice row: nothing honest to prepare against.
  const policy = await preparePolicyTargets(sql, claimed.accountId, generated.proposals);
  if (policy === null) {
    await failTurnUnauthorized(sql, claimed, outbox);
    logger.warn('agent_turn policy target not found', { turn_id: claimed.turnId });
    return null;
  }

  const proposals = buildProposalRows(
    {
      conversationId: claimed.conversationId,
      turnId: claimed.turnId,
      accountId: claimed.accountId,
      actorUserId: claimed.actorUserId,
      locationId: claimed.locationId,
    },
    // The VALIDATOR's parsed proposals: the catalog lookup and the input
    // parse already happened there, once.
    generated.proposals,
    voice,
    policy,
  );
  const unsupported: UnsupportedRow[] = generated.output.unsupported.map((u) => ({
    id: uuidv7(),
    accountId: claimed.accountId,
    turnId: claimed.turnId,
    request: u.request,
    context: u.context,
  }));
  // Reserve original model indices. Restore rows and refusal subjects do not
  // exist until the completion transaction wins its turn fence.
  let ordinaryIndex = 0;
  const proposalIds = generated.output.proposals.map((proposal) => {
    if (proposal.operation === 'restore_last') return null;
    const row = proposals[ordinaryIndex++];
    if (!row) throw new Error('agents/operator: ordinary proposal index has no prepared row');
    return row.id;
  });
  const replyPlan: TurnReplyPlan = {
    segments: generated.output.segments,
    metrics: snapshot.metrics,
    proposalIds,
    restoreRequests: generated.restoreRequests,
    scrubbed: scrubbed.scrubbed,
  };

  return { replyPlan, proposals, unsupported, attempts: generated.attempts };
}

/**
 * The turn's error policy, in one place. Returns only for a decision that is
 * terminal on purpose; everything else rethrows for the BullMQ ladder.
 */
async function handleTurnError(
  sql: Sql,
  error: unknown,
  claimed: ClaimedTurn,
  outbox: OutboxHandle,
  logger: WorkerLogger,
): Promise<void> {
  if (error instanceof DelayedError) throw error;
  if (isBudgetDecision(error)) {
    // Terminal per the cost-guard contract: one account's exhausted budget is
    // not a systemic failure and must not burn the retry ladder.
    await failTurnFenced(sql, {
      turnId: claimed.turnId,
      accountId: claimed.accountId,
      attemptToken: claimed.attemptToken,
      reason: TURN_FAILURE_REASON.BUDGET_EXCEEDED,
      ...outbox,
    });
    logger.warn('agent_turn budget exceeded', { turn_id: claimed.turnId });
    return;
  }
  // Transient (TransientLLMError, CostInfraUnavailableError, transient
  // Postgres): rethrow for the BullMQ ladder — but RELEASE THE CLAIM FIRST,
  // fenced on this attempt's token.
  //
  // Without the release the retry lands ~5 s later, inside the 180 s lease,
  // and `claimTurn` returns null. The handler would then complete the job
  // having done nothing, and the turn would sit `running` until the lease
  // expired and the watchdog re-pended the row — minutes of nothing for a
  // blip the BullMQ ladder was already retrying.
  //
  // The release is fenced, so an attempt that has since lost its lease
  // releases nothing. A CRASHED process cannot run this at all; that case
  // still relies on lease expiry plus the watchdog, which is what those two
  // mechanisms are for.
  const released = await releaseTurnClaim(sql, {
    turnId: claimed.turnId,
    accountId: claimed.accountId,
    attemptToken: claimed.attemptToken,
    leaseSeconds: AGENT_TURN_LEASE_SECONDS,
    ...outbox,
  });
  if (released === 'failed') {
    logger.warn('agent_turn dispatch exhausted before claim release', { turn_id: claimed.turnId });
    return;
  }
  // A predecessor delay may already have released this token before Redis
  // rejected moveToDelayed. Preserve that error for the BullMQ retry ladder.
  throw error;
}

export async function handleAgentTurn(sql: Sql, job: Job<AgentTurnPayload>): Promise<void> {
  const logger = createWorkerLogger('[AgentTurnWorker]', job.data.correlation_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);
  const outbox: OutboxHandle = { outboxId, outboxAttempt };

  // Kill switch first: a disabled Operator never loads tenant context.
  if (!ownerOperatorEnabled()) {
    logger.log('agent_turn flag-off skip', { turn_id: job.data.turn_id });
    // An orderly decision, not a failure. The helper's own transaction runs the
    // outbox ownership CAS FIRST and transitions the turn only if it wins, so a
    // dispatch the watchdog has already superseded writes nothing.
    await failTurnAndCompleteOutbox(sql, {
      turnId: job.data.turn_id,
      accountId: job.data.account_id,
      reason: TURN_FAILURE_REASON.OPERATOR_DISABLED,
      ...outbox,
    });
    return;
  }

  // ── Step 1: claim ────────────────────────────────────────────────────────
  const claimed = await claimTurn(sql, {
    turnId: job.data.turn_id,
    accountId: job.data.account_id,
    leaseSeconds: AGENT_TURN_LEASE_SECONDS,
  });
  if (!claimed) {
    await settleClaimMiss(sql, job.data, outbox, logger);
    return;
  }

  try {
    // ── Step 2: predecessor ────────────────────────────────────────────────
    if (await waitOrFailOnPredecessor(sql, job, claimed, outbox, logger)) return;

    // ── Steps 3–7: authorize, scrub, snapshot, model, validate, map to rows ─
    const assembled = await generateAndAssemble(sql, claimed, outbox, logger);
    if (!assembled) return;

    // ── Step 7: fenced completion ──────────────────────────────────────────
    const { fenced } = await completeTurnFenced(sql, {
      turnId: claimed.turnId,
      accountId: claimed.accountId,
      conversationId: claimed.conversationId,
      attemptToken: claimed.attemptToken,
      segments: [],
      replyPlan: assembled.replyPlan,
      proposals: assembled.proposals,
      unsupported: assembled.unsupported,
      ...outbox,
    });
    if (!fenced) {
      // The lease was lost while the model ran. Discard and exit: the owning
      // attempt completes the turn and the outbox row.
      logger.warn('agent_turn lease lost before completion', { turn_id: claimed.turnId });
      return;
    }

    logger.log('agent_turn completed', {
      turn_id: claimed.turnId,
      proposal_count: assembled.proposals.length,
      unsupported_count: assembled.unsupported.length,
      attempts: assembled.attempts,
    });
  } catch (error) {
    await handleTurnError(sql, error, claimed, outbox, logger);
  }
}
