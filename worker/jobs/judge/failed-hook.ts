import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { anchorReviewLockOrder } from '@/lib/approval/outcomes';
import { JUDGE_PROMPT_VERSION } from '@/lib/responses/judge-policy';
import {
  JUDGE_ERROR_MODEL_UNAVAILABLE,
  JUDGE_ERROR_REASON_BUDGET_EXCEEDED,
  findLatestRunIdForReview,
  insertJudgeVerdict,
} from '@/lib/responses/judge-store';
import { createWorkerLogger } from '@/lib/shared/logger';
import {
  extractOutboxHandle,
  markOutboxFailed,
} from '@/lib/shared/outbox';
import type { JudgeVerdictPayload } from '@/lib/shared/worker-types';
import { loadJudgeContext } from './context';

const logger = createWorkerLogger('[JudgeWorker.failed]');

/**
 * Budget-DECISION failures (terminal per the cost-guard contract): one
 * account's daily budget exhaustion is not systemic judge failure. Matched by
 * error name in-process, with a message-substring fallback for a failedReason
 * rehydrated from Redis. RegenBudgetExceededError never reaches the judge
 * lane (no regenerate path), so it is deliberately absent.
 */
const BUDGET_DECISION_ERROR_NAMES: readonly string[] = [
  'CostLimitExceededError',
  'GlobalCostLimitExceededError',
];

function isBudgetDecisionFailure(job: Job<JudgeVerdictPayload>, err: unknown): boolean {
  if (err instanceof Error && BUDGET_DECISION_ERROR_NAMES.includes(err.name)) return true;
  const failedReason = typeof job.failedReason === 'string' ? job.failedReason : '';
  return failedReason.includes('cost limit exceeded');
}

function boundedErrorClass(err: unknown): string {
  if (err instanceof Error && err.name) return err.name.slice(0, 100);
  return 'UnknownError';
}

function isJudgeAttemptExhausted(job: Job<JudgeVerdictPayload>): boolean {
  const maxAttempts = typeof job.opts.attempts === 'number' && job.opts.attempts > 0
    ? job.opts.attempts
    : 1;
  // Terminal-attempt check for the BullMQ 'failed' EVENT context: the Worker
  // emits 'failed' only after job.moveToFailed() has incremented attemptsMade
  // to include the failing attempt, so with attempts=3 only 3/3 is terminal
  // (2/3 still has a retry). The shared isTerminalAttempt
  // (src/lib/shared/outbox.ts) answers the same question INSIDE a processor
  // catch block, where attemptsMade has NOT yet been incremented — hence its
  // `attemptsMade + 1 >= maxAttempts`. Both are correct in their own call
  // context; do not unify them.
  return job.attemptsMade >= maxAttempts;
}

export async function handleJudgeFailed(
  sql: Sql,
  job: Job<JudgeVerdictPayload> | undefined,
  err: unknown,
): Promise<void> {
  if (!job || !isJudgeAttemptExhausted(job)) return;

  try {
    const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);
    const errorClass = boundedErrorClass(err);
    const budgetDecision = isBudgetDecisionFailure(job, err);
    const context = await loadJudgeContext(sql, {
      responseId: job.data.response_id,
      businessId: job.data.business_id,
      accountId: job.data.account_id,
    });
    if (!context) {
      await markOutboxFailed(sql, outboxId, `judge_exhausted:${errorClass}`, attempt);
      return;
    }

    await sql.begin(async (tx) => {
      // Binding review-lane lock order: the anchor is the transaction's FIRST
      // lock, before the verdict INSERT's implicit FK locks.
      const reviewId = await anchorReviewLockOrder(
        tx,
        context.response_id,
        context.business_id,
      );
      if (!reviewId) {
        await markOutboxFailed(tx, outboxId, `judge_exhausted:${errorClass}`, attempt);
        return;
      }

      // Binding lane order continues reviews -> businesses -> responses:
      // without this explicit lock, the verdict INSERT's implicit businesses
      // FK lock would be the first businesses acquisition, after the response
      // FK lock — inverting the lane order.
      const [lockedBusiness] = await tx<{ id: string }[]>`
        SELECT id
        FROM businesses
        WHERE id = ${context.business_id}
        FOR UPDATE
      `;
      if (!lockedBusiness) {
        await markOutboxFailed(tx, outboxId, `judge_exhausted:${errorClass}`, attempt);
        return;
      }

      // Claim the dispatched attempt before recording its terminal domain fact.
      const claimed = await markOutboxFailed(
        tx,
        outboxId,
        `judge_exhausted:${errorClass}`,
        attempt,
      );
      if (!claimed) return;

      const agentRunId = await findLatestRunIdForReview(tx, reviewId);
      await insertJudgeVerdict(tx, {
        accountId: context.account_id,
        businessId: context.business_id,
        reviewId,
        responseId: context.response_id,
        agentRunId,
        verdict: 'error',
        reasons: budgetDecision ? [JUDGE_ERROR_REASON_BUDGET_EXCEEDED] : null,
        rationale: errorClass,
        model: JUDGE_ERROR_MODEL_UNAVAILABLE,
        promptVersion: JUDGE_PROMPT_VERSION,
      });
    });
  } catch (handlerError) {
    // If a transaction began, it rolled back as a unit; otherwise the outbox
    // stayed dispatched. In either case the watchdog can reclaim it. Do not
    // split the verdict/outbox terminal checkpoint from this failure callback.
    logger.error('Terminal judge checkpoint failed', {
      error_name: handlerError instanceof Error ? handlerError.name : 'unknown',
      response_id: job.data.response_id,
    });
  }
}
