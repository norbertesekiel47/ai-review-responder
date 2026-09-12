import { DelayedError, type Job } from 'bullmq';
import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { reauthorizeTurn } from '@/lib/agents/operator/authorize';
import { proposableOperation } from '@/lib/agents/operator/catalog';
import { buildSnapshot, type SnapshotMetrics } from '@/lib/agents/operator/context';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import { generateOperatorReply } from '@/lib/agents/operator/model-call';
import type { ProposalRow, UnsupportedRow } from '@/lib/agents/operator/proposals';
import { scrubPastedReview } from '@/lib/agents/operator/render';
import {
  PROPOSAL_STATUS,
  SERVER_NOTICE,
  STATUS_METRICS,
  TURN_FAILURE_REASON,
  type StatusMetric,
  type StoredSegment,
} from '@/lib/agents/operator/schema';
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
} from '@/lib/agents/operator/turns';
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

export async function handleAgentTurn(sql: Sql, job: Job<AgentTurnPayload>): Promise<void> {
  const logger = createWorkerLogger('[AgentTurnWorker]', job.data.correlation_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

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
      outboxId,
      outboxAttempt,
    });
    return;
  }

  const claimed = await claimTurn(sql, {
    turnId: job.data.turn_id,
    accountId: job.data.account_id,
    leaseSeconds: AGENT_TURN_LEASE_SECONDS,
  });
  if (!claimed) {
    // Two very different reasons the claim missed, and they need opposite
    // handling.
    //
    // A live lease held elsewhere: exit without touching the outbox row, which
    // belongs to the holder.
    //
    // A turn that is ALREADY TERMINAL: the attempt that finished it completed a
    // DIFFERENT outbox attempt than this dispatch carries, so this row is still
    // `dispatched` and nothing else will ever move it. Left alone the watchdog
    // re-pends it forever against a turn that is finished. Complete it here.
    const terminal = await readTerminalTurn(sql, {
      turnId: job.data.turn_id,
      accountId: job.data.account_id,
    });
    if (terminal) {
      logger.log('agent_turn already terminal, completing outbox', {
        turn_id: job.data.turn_id,
        turn_status: terminal.status,
      });
      await markOutboxCompletedIfOwned(sql, outboxId, outboxAttempt);
      return;
    }
    logger.log('agent_turn claim not acquired', { turn_id: job.data.turn_id });
    return;
  }

  try {
    // ── Step 2: predecessor ────────────────────────────────────────────────
    const predecessor = claimed.sequence <= 1
      ? null
      : await loadPredecessor(sql, {
        conversationId: claimed.conversationId,
        accountId: claimed.accountId,
        sequence: claimed.sequence,
      });
    if (predecessor && !isTerminalTurnStatus(predecessor.status)) {
      if (predecessor.ageSeconds > AGENT_TURN_PREDECESSOR_STALL_SECONDS) {
        await failTurnFenced(sql, {
          turnId: claimed.turnId,
          accountId: claimed.accountId,
          attemptToken: claimed.attemptToken,
          reason: TURN_FAILURE_REASON.PREDECESSOR_STALLED,
          outboxId,
          outboxAttempt,
        });
        logger.warn('agent_turn predecessor stalled', {
          turn_id: claimed.turnId,
          predecessor_age_seconds: predecessor.ageSeconds,
        });
        return;
      }
      // Give the claim back and DELAY rather than throw: moveToDelayed +
      // DelayedError re-schedules the same job without consuming an attempt,
      // so a conversation with a slow first turn never exhausts its retry
      // budget waiting in line.
      await releaseTurnClaim(sql, {
        turnId: claimed.turnId,
        accountId: claimed.accountId,
        attemptToken: claimed.attemptToken,
      });
      logger.log('agent_turn waiting on predecessor', {
        turn_id: claimed.turnId,
        sequence: claimed.sequence,
      });
      await job.moveToDelayed(Date.now() + AGENT_TURN_PREDECESSOR_WAIT_MS, job.token);
      throw new DelayedError();
    }

    // ── Step 3: authorize again ────────────────────────────────────────────
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
        outboxId,
        outboxAttempt,
      });
      logger.warn('agent_turn reauthorization failed', {
        turn_id: claimed.turnId,
        reason: authorized.reason,
      });
      return;
    }

    // ── Steps 4–6: scrub, snapshot, model, validate ────────────────────────
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
        outboxId,
        outboxAttempt,
      });
      logger.warn('agent_turn model output invalid', {
        turn_id: claimed.turnId,
        attempts: generated.attempts,
      });
      return;
    }

    // ── Step 7: map to rows, then fenced completion ────────────────────────
    const voice = await readVoiceConfig(sql, {
      accountId: claimed.accountId,
      locationId: claimed.locationId,
    });
    const proposals = buildProposalRows(claimed, generated.output.proposals, voice);
    const unsupported: UnsupportedRow[] = generated.output.unsupported.map((u) => ({
      id: uuidv7(),
      accountId: claimed.accountId,
      turnId: claimed.turnId,
      request: u.request,
      context: u.context,
    }));

    // MATERIALIZE the reply. Two transforms, both of which exist so the stored
    // row is the whole truth and the GET route never re-derives anything:
    //
    //  1. every `status_ref` becomes a `status` carrying the value the server
    //     read, its reporting period and the instant it read it. Resolving the
    //     metric name later would paint today's count onto a sentence written
    //     about a different one.
    //  2. a scrubbed message prepends the fixed notice, which the GET route
    //     could not re-derive: it never sees the owner's raw message.
    const storedSegments: StoredSegment[] = [];
    for (const segment of generated.output.segments) {
      if (segment.type !== 'status_ref') {
        storedSegments.push(segment);
        continue;
      }
      // The model union types `status_ref.metric` as a bounded STRING (the
      // schema cannot enum it without the model losing the ability to name a
      // metric the validator can reject with a reason). `validateModelOutput`
      // has already refused anything outside STATUS_METRICS, so this guard is
      // the TYPE narrowing for that decision, not a second policy. An
      // unreachable miss is dropped rather than thrown: the turn's budget is
      // already spent, and one missing sentence beats a retry that cannot
      // converge.
      if (!isStatusMetric(segment.metric)) continue;
      storedSegments.push(materializeStatus(segment.metric, snapshot.metrics));
    }
    if (scrubbed.scrubbed) {
      storedSegments.unshift({ type: 'server_notice', notice: SERVER_NOTICE.PASTED_REVIEW_REMOVED });
    }

    const { fenced } = await completeTurnFenced(sql, {
      turnId: claimed.turnId,
      accountId: claimed.accountId,
      conversationId: claimed.conversationId,
      attemptToken: claimed.attemptToken,
      segments: storedSegments,
      proposals,
      unsupported,
      outboxId,
      outboxAttempt,
    });
    if (!fenced) {
      // The lease was lost while the model ran. Discard and exit: the owning
      // attempt completes the turn and the outbox row.
      logger.warn('agent_turn lease lost before completion', { turn_id: claimed.turnId });
      return;
    }

    logger.log('agent_turn completed', {
      turn_id: claimed.turnId,
      proposal_count: proposals.length,
      unsupported_count: unsupported.length,
      attempts: generated.attempts,
    });
  } catch (error) {
    if (error instanceof DelayedError) throw error;
    if (isBudgetDecision(error)) {
      // Terminal per the cost-guard contract: one account's exhausted budget is
      // not a systemic failure and must not burn the retry ladder.
      await failTurnFenced(sql, {
        turnId: claimed.turnId,
        accountId: claimed.accountId,
        attemptToken: claimed.attemptToken,
        reason: TURN_FAILURE_REASON.BUDGET_EXCEEDED,
        outboxId,
        outboxAttempt,
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
    await releaseTurnClaim(sql, {
      turnId: claimed.turnId,
      accountId: claimed.accountId,
      attemptToken: claimed.attemptToken,
    });
    throw error;
  }
}

function isStatusMetric(value: string): value is StatusMetric {
  return (STATUS_METRICS as readonly string[]).includes(value);
}

/**
 * One `status_ref` → the stored `status` it becomes. The validator has already
 * rejected any metric outside `STATUS_METRICS`, so the switch is total.
 */
function materializeStatus(metric: StatusMetric, metrics: SnapshotMetrics): StoredSegment {
  const value = metric === 'pending_count'
    ? metrics.pendingCount
    : metric === 'posted_7d'
      ? metrics.posted7d
      : metrics.draftsWaiting;
  return {
    type: 'status',
    metric,
    value,
    reportingPeriodDays: metrics.reportingPeriodDays,
    asOf: metrics.asOf,
  };
}

/**
 * Model proposals → storable rows. `before`/`after` are the FULL effective
 * voice state of the location, computed server-side from the catalog's own
 * preview, never from anything the model said. `requires_confirmation` is
 * always false in Run A: no registered operation widens autonomy (L5).
 */
function buildProposalRows(
  claimed: ClaimedTurn,
  proposals: readonly {
    operation: string;
    scope: { accountId: string; locationId?: string };
    input: Record<string, unknown>;
    rationale: string;
  }[],
  voice: (Awaited<ReturnType<typeof readVoiceConfig>>),
): ProposalRow[] {
  const rows: ProposalRow[] = [];
  for (const proposal of proposals) {
    const operation = proposableOperation(proposal.operation);
    // The validator already rejected an unknown operation or an out-of-domain
    // input, so a miss here is unreachable; skipping rather than throwing keeps
    // a future catalog edit from failing a turn that already spent its budget.
    if (!operation || !voice) continue;
    const parsed = operation.parseInput(proposal.input);
    if (!parsed.ok) continue;
    const { before, after } = operation.preview(voice, parsed.input);
    rows.push({
      id: uuidv7(),
      conversationId: claimed.conversationId,
      turnId: claimed.turnId,
      accountId: claimed.accountId,
      actorUserId: claimed.actorUserId,
      locationId: proposal.scope.locationId ?? null,
      operation: operation.id,
      contractVersion: operation.contractVersion,
      input: parsed.input,
      before: { ...before },
      after: { ...after },
      rationale: proposal.rationale,
      labelKind: operation.labelKind,
      preparedVersionToken: { businessId: claimed.locationId, updatedAt: voice.updatedAt },
      // Always false in Run A: no registered operation widens autonomy (L5).
      requiresConfirmation: false,
      status: PROPOSAL_STATUS.PENDING,
    });
  }
  return rows;
}
