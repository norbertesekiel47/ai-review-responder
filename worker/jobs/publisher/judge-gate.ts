import type { Sql } from 'postgres';
import { judgeEnabled } from '@/lib/responses/judge-flags';
import { isJudgeHealthy } from '@/lib/responses/judge-health';
import { downgradeAutoApprovedResponseForManualReview } from './auto-policy-downgrade';

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
