import type { Sql } from 'postgres';
import { calculateCostUsd, recordApiCost } from '@/lib/costs/audit';
import { withCostGuard } from '@/lib/costs/cost-guard';
import { runLlmTask } from '@/lib/llm/run-task';
import type { ChatPrompt, LLMCallResult } from '@/lib/llm/types';
import { createWorkerLogger } from '@/lib/shared/logger';
import {
  JUDGE_PROMPT_VERSION,
  JUDGE_SYSTEM_PROMPT,
  judgeSystemPromptHash,
} from './judge-policy';
import { JudgeOutputSchema, type JudgeOutput } from './judge-schema';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';

const logger = createWorkerLogger('[response-judge]');

export interface JudgePromptInput {
  reviewRating: number | null;
  reviewText: string | null;
  postedReplyText: string;
}

export interface JudgeResponseInput extends JudgePromptInput {
  responseId: string;
  businessId: string;
  accountId: string;
  subscriptionTier: SubscriptionTierValue;
}

export interface JudgeCallResult extends JudgeOutput {
  model: string;
  promptVersion: string;
}

/** Build the single production prompt envelope shared by workers and live evals. */
export function buildJudgePrompt(input: JudgePromptInput): ChatPrompt {
  return {
    system: JUDGE_SYSTEM_PROMPT,
    user: JSON.stringify({
      reviewRating: input.reviewRating,
      reviewText: input.reviewText,
      postedReplyText: input.postedReplyText,
    }),
  };
}

async function tryRecordJudgeCost(
  sql: Sql,
  identifiers: Pick<JudgeResponseInput, 'businessId' | 'accountId' | 'responseId'>,
  llm: LLMCallResult,
  costUsd: number,
  latencyMs: number,
): Promise<void> {
  try {
    await recordApiCost(sql, {
      businessId: identifiers.businessId,
      accountId: identifiers.accountId,
      provider: llm.provider,
      endpoint: 'response-judge',
      inputTokens: llm.usage.promptTokens,
      outputTokens: llm.usage.completionTokens,
      costUsd,
      responseId: identifiers.responseId,
      systemPromptHash: judgeSystemPromptHash(),
      promptVersion: JUDGE_PROMPT_VERSION,
      latencyMs,
    });
  } catch (auditError) {
    logger.error('Failed to record api_costs audit row', {
      error_name: auditError instanceof Error ? auditError.name : 'unknown',
    });
  }
}

/**
 * Evaluate one posted reply through the pinned judge task and two-phase cost guard.
 * Failure classification belongs to the seam/guard and propagates unchanged to the
 * worker retry ladder; only the post-call api_costs audit is best-effort.
 */
export async function judgeResponse(
  sql: Sql,
  input: JudgeResponseInput,
): Promise<JudgeCallResult> {
  const prompt = buildJudgePrompt(input);
  const guarded = await withCostGuard(
    {
      businessId: input.businessId,
      subscriptionTier: input.subscriptionTier,
      withConcurrency: false,
      onFinalizeError: 'log-and-return-value',
    },
    async () => {
      const startedAt = Date.now();
      const llm = await runLlmTask('judge', prompt);
      const latencyMs = Date.now() - startedAt;
      const output = JudgeOutputSchema.parse(llm.structured);
      const costUsd = calculateCostUsd(
        llm.model,
        llm.usage.promptTokens,
        llm.usage.completionTokens,
      );
      return {
        value: { llm, output, costUsd, latencyMs },
        actualCostCents: Math.ceil(costUsd * 100),
      };
    },
  );

  await tryRecordJudgeCost(sql, input, guarded.llm, guarded.costUsd, guarded.latencyMs);

  return {
    ...guarded.output,
    model: guarded.llm.model,
    promptVersion: JUDGE_PROMPT_VERSION,
  };
}
