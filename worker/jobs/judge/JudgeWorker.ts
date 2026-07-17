import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { anchorReviewLockOrder } from '@/lib/approval/outcomes';
import { lockAutonomyAccount } from '@/lib/auto-approval/account-lock';
import { suspendAccountAutonomy } from '@/lib/auto-approval/suspension';
import { judgeResponse } from '@/lib/responses/judge';
import { judgeEnabled } from '@/lib/responses/judge-flags';
import { findLatestRunIdForReview, insertJudgeVerdict } from '@/lib/responses/judge-store';
import { createWorkerLogger } from '@/lib/shared/logger';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxCompletedIfOwned,
} from '@/lib/shared/outbox';
import { checkSubscription } from '@/lib/shared/subscription-guard';
import type { JudgeVerdictPayload } from '@/lib/shared/worker-types';
import { isJudgeEligibleContext, isPostedAutoPolicyResponse, loadJudgeContext } from './context';

export async function handleJudgeVerdict(
  sql: Sql,
  job: Job<JudgeVerdictPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[JudgeWorker]', job.data.correlation_id);
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  // Kill switch first: disabled Judge work never loads tenant/review content.
  if (!judgeEnabled()) {
    logger.log(`judge_verdict flag-off skip response=${job.data.response_id}`);
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }

  const context = await loadJudgeContext(sql, {
    responseId: job.data.response_id,
    businessId: job.data.business_id,
    accountId: job.data.account_id,
  });
  if (
    !context
    || !isJudgeEligibleContext(context)
    || !checkSubscription({
      status: context.subscription_status,
      pastDueAt: context.account_past_due_at,
      accountFlags: context.account_flags,
      workerType: 'publisher',
    }).allowed
  ) {
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }

  const verdict = await judgeResponse(sql, {
    responseId: context.response_id,
    businessId: context.business_id,
    accountId: context.account_id,
    subscriptionTier: context.subscription_tier,
    reviewRating: context.star_rating,
    reviewText: context.review_text,
    postedReplyText: context.posted_reply_text,
  });

  await sql.begin(async (tx) => {
    // Binding global lock order: reviews must be the first transaction lock,
    // before the verdict INSERT's implicit response/run FK locks.
    const anchoredReviewId = await anchorReviewLockOrder(
      tx,
      context.response_id,
      context.business_id,
    );
    if (!anchoredReviewId) {
      await markOutboxCompleted(tx, outboxId, attempt);
      return;
    }

    // Binding lane order continues reviews -> businesses -> responses: without
    // this explicit lock, the verdict INSERT's implicit businesses FK lock
    // would only be taken AFTER the response lock, inverting the lane order.
    const [lockedBusiness] = await tx<{ id: string }[]>`
      SELECT id
      FROM businesses
      WHERE id = ${context.business_id}
      FOR UPDATE
    `;
    if (!lockedBusiness) {
      await markOutboxCompleted(tx, outboxId, attempt);
      return;
    }

    const [current] = await tx<{ status: string; approval_method: string | null }[]>`
      SELECT status, approval_method
      FROM responses
      WHERE id = ${context.response_id}
        AND business_id = ${context.business_id}
      FOR UPDATE
    `;
    if (!current || !isPostedAutoPolicyResponse(current)) {
      await markOutboxCompleted(tx, outboxId, attempt);
      return;
    }

    // Claim this exact dispatched attempt before any durable Judge-domain
    // write. Because this runs in the same transaction, later failures roll
    // completion back; stale attempts perform no verdict/suspension mutation.
    const ownsAttempt = await markOutboxCompletedIfOwned(tx, outboxId, attempt);
    if (!ownsAttempt) return;

    const agentRunId = await findLatestRunIdForReview(tx, anchoredReviewId);
    const verdictId = uuidv7();
    if (verdict.verdict === 'flag') {
      // Deadlock guard (lane order ends at accounts): the verdict INSERT's RI
      // trigger takes FOR KEY SHARE on this account row, and
      // suspendAccountAutonomy then upgrades it to FOR UPDATE. Two concurrent
      // flag verdicts for the same account (different reviews, so the review
      // anchors don't serialize them) would each hold KEY SHARE while waiting
      // on the other's upgrade — deadlock. Take accounts FOR UPDATE BEFORE the
      // INSERT, still after the reviews -> businesses -> responses locks.
      // Non-flag verdicts must NOT take this lock: routine passes would
      // otherwise serialize per account.
      await lockAutonomyAccount(tx, context.account_id);
    }
    const stored = await insertJudgeVerdict(tx, {
      verdictId,
      accountId: context.account_id,
      businessId: context.business_id,
      reviewId: anchoredReviewId,
      responseId: context.response_id,
      agentRunId,
      verdict: verdict.verdict,
      reasons: verdict.reasons,
      rationale: verdict.rationale,
      model: verdict.model,
      promptVersion: verdict.promptVersion,
    });
    if (stored.inserted && verdict.verdict === 'flag') {
      await suspendAccountAutonomy(tx, {
        accountId: context.account_id,
        trigger: 'judge_flag',
        suspensionEventId: uuidv7(),
        evidence: { verdict_id: verdictId },
        correlationId: job.data.correlation_id,
      });
    }
  });
}
