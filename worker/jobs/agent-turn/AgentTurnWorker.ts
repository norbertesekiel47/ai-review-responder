import { DelayedError, type Job } from 'bullmq';
import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { reauthorizeTurn } from '@/lib/agents/operator/authorize';
import { buildSnapshot } from '@/lib/agents/operator/context';
import { ownerOperatorEnabled } from '@/lib/agents/operator/flags';
import { generateOperatorReply } from '@/lib/agents/operator/model-call';
import { buildProposalRows, type UnsupportedRow } from '@/lib/agents/operator/proposals';
import { materializeReply, scrubPastedReview } from '@/lib/agents/operator/render';
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
    if (!voice) {
      // The location vanished between step 3 and here — archived, or moved to
      // another account. That is an AUTHORIZATION change, not a mapping
      // detail: every proposal is prepared against this row's voice state and
      // its `updated_at` **Version token**, so there is nothing honest to
      // store. Failing here is what keeps the turn from completing with a
      // reply whose cards were all silently dropped.
      await failTurnFenced(sql, {
        turnId: claimed.turnId,
        accountId: claimed.accountId,
        attemptToken: claimed.attemptToken,
        reason: TURN_FAILURE_REASON.UNAUTHORIZED,
        outboxId,
        outboxAttempt,
      });
      logger.warn('agent_turn location voice row vanished after authorization', {
        turn_id: claimed.turnId,
      });
      return;
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
    );
    const unsupported: UnsupportedRow[] = generated.output.unsupported.map((u) => ({
      id: uuidv7(),
      accountId: claimed.accountId,
      turnId: claimed.turnId,
      request: u.request,
      context: u.context,
    }));
    // The stored reply, materialized in one place (`materializeReply`, render.ts):
    // `status_ref` → a frozen `status`, `proposal_ref` → a stored `proposal` id,
    // and the scrub notice prepended. Index-aligned with `generated.proposals`
    // by construction — the validator returned them in the model's own order
    // and `buildProposalRows` maps one-to-one over that array.
    const storedSegments = materializeReply({
      segments: generated.output.segments,
      metrics: snapshot.metrics,
      proposalIds: proposals.map((row) => row.id),
      scrubbed: scrubbed.scrubbed,
    });

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

