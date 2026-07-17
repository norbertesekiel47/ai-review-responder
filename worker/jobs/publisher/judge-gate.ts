import type { Sql, TransactionSql } from 'postgres';
import { judgeEnabled } from '@/lib/responses/judge-flags';
import { isJudgeHealthy } from '@/lib/responses/judge-health';
import {
  downgradeAutoApprovedResponseForManualReview,
  downgradeAutoApprovedResponseForManualReviewInTx,
} from './auto-policy-downgrade';

interface JudgeGateContext {
  responseId: string;
  businessId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  correlationId: string | undefined;
  logger: { warn(message: string): void };
}

export async function applyJudgeGate(
  sql: Sql,
  context: JudgeGateContext,
): Promise<'post' | 'downgraded'> {
  if (!judgeEnabled()) {
    await downgradeAutoApprovedResponseForManualReview(sql, {
      ...context,
      reason: 'judge_disabled',
    });
    return 'downgraded';
  }

  if (!await isJudgeHealthy(sql)) {
    await downgradeAutoApprovedResponseForManualReview(sql, {
      ...context,
      reason: 'judge_unhealthy',
    });
    return 'downgraded';
  }

  return 'post';
}

/** Judge gate for a caller already holding the full auto-policy lock lane. */
export async function applyJudgeGateInTx(
  tx: TransactionSql,
  context: JudgeGateContext,
): Promise<'post' | 'downgraded'> {
  if (!judgeEnabled()) {
    await downgradeAutoApprovedResponseForManualReviewInTx(tx, {
      ...context,
      reason: 'judge_disabled',
    });
    return 'downgraded';
  }

  if (!await isJudgeHealthy(tx)) {
    await downgradeAutoApprovedResponseForManualReviewInTx(tx, {
      ...context,
      reason: 'judge_unhealthy',
    });
    return 'downgraded';
  }

  return 'post';
}
