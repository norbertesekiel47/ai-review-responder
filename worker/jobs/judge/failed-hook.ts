import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { anchorReviewLockOrder } from '@/lib/approval/outcomes';
import { OPENAI_MODEL } from '@/lib/llm/tasks';
import { JUDGE_PROMPT_VERSION } from '@/lib/responses/judge-policy';
import { findLatestRunIdForReview, insertJudgeVerdict } from '@/lib/responses/judge-store';
import { createWorkerLogger } from '@/lib/shared/logger';
import {
  extractOutboxHandle,
  markOutboxFailed,
} from '@/lib/shared/outbox';
import type { JudgeVerdictPayload } from '@/lib/shared/worker-types';
import { loadJudgeContext } from './context';

const logger = createWorkerLogger('[JudgeWorker.failed]');

function boundedErrorClass(err: unknown): string {
  if (err instanceof Error && err.name) return err.name.slice(0, 100);
  return 'UnknownError';
}

function isJudgeAttemptExhausted(job: Job<JudgeVerdictPayload>): boolean {
  const maxAttempts = typeof job.opts.attempts === 'number' && job.opts.attempts > 0
    ? job.opts.attempts
    : 1;
  // BullMQ's `failed` event observes attemptsMade after the failed attempt was
  // incremented. 2/3 still has one retry; only 3/3 is terminal.
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
      // FIRST statement: the verdict INSERT takes implicit review-lane FK locks.
      const reviewId = await anchorReviewLockOrder(
        tx,
        context.response_id,
        context.business_id,
      );
      if (!reviewId) {
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
        reasons: null,
        rationale: errorClass,
        model: OPENAI_MODEL,
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
