// One cost-guarded owner_operator call with at most one validation retry.
// Structure follows src/lib/responses/judge.ts:80 — the guard wraps the call,
// the reservation precedes it, and only the post-call api_costs audit is
// best-effort.
import type postgres from 'postgres';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { calculateCostUsd, recordApiCost } from '@/lib/costs/audit';
import { withCostGuard } from '@/lib/costs/cost-guard';
import { runLlmTask, LLMStructuredOutputError } from '@/lib/llm/run-task';
import type { LLMCallResult } from '@/lib/llm/types';
import { createWorkerLogger } from '@/lib/shared/logger';
import type { Snapshot } from './context';
import { buildOperatorPrompt, operatorSystemPromptHash, OWNER_OPERATOR_PROMPT_VERSION } from './prompt';
import { semanticRejectionCodes, validateModelOutput, type ParsedProposal, type ParsedRestoreRequest } from './render';
import { OperatorModelOutputSchema, type ModelOutput } from './schema';

type Sql = postgres.Sql;

const logger = createWorkerLogger('[owner-operator]');

/** Two attempts total: the first, and one retry carrying the rejection reason. */
const MAX_ATTEMPTS = 2;

export interface GenerateOperatorReplyInput {
  accountId: string;
  locationId: string;
  subscriptionTier: SubscriptionTierValue;
  snapshot: Snapshot;
  ownerText: string;
  turnId: string;
}

export type GenerateOperatorReplyResult =
  /**
   * `proposals` is the VALIDATOR's own parsed output — the resolved catalog
   * entry and the narrowed input, in the model's order — so the row builder
   * does not repeat the lookup and the parse the gate already did.
   */
  | { ok: true; output: ModelOutput; proposals: ParsedProposal[]; restoreRequests: ParsedRestoreRequest[]; attempts: number }
  | { ok: false; reason: 'model_output_invalid'; attempts: number };

/** The audit needs provider, model and usage — not the whole call result. */
type BilledCall = Pick<LLMCallResult, 'provider' | 'model' | 'usage'>;

async function tryRecordOperatorCost(
  sql: Sql,
  input: GenerateOperatorReplyInput,
  llm: BilledCall,
  costUsd: number,
  latencyMs: number,
): Promise<void> {
  try {
    await recordApiCost(sql, {
      businessId: input.locationId,
      accountId: input.accountId,
      provider: llm.provider,
      endpoint: 'owner-operator',
      inputTokens: llm.usage.promptTokens,
      outputTokens: llm.usage.completionTokens,
      costUsd,
      responseId: null,
      systemPromptHash: operatorSystemPromptHash(),
      promptVersion: OWNER_OPERATOR_PROMPT_VERSION,
      latencyMs,
    });
  } catch (auditError) {
    logger.error('Failed to record api_costs audit row', {
      error_name: auditError instanceof Error ? auditError.name : 'unknown',
      turn_id: input.turnId,
    });
  }
}

/**
 * EVERY attempt is billed and audited, including the one whose output failed
 * validation: the provider returned tokens and only the shape was wrong. This
 * is not exactly-once inference (spec §5.2 step 5).
 *
 * A shape failure is handled INSIDE the guarded closure and returned as a
 * value, never thrown past the guard, so the reservation finalizes against the
 * real spend rather than being released as if nothing ran.
 *
 * Transient errors (`TransientLLMError`, `CostInfraUnavailableError`) and
 * budget decisions (`CostLimitExceededError`, `GlobalCostLimitExceededError`)
 * do propagate unchanged — the worker's catch maps them.
 */
export async function generateOperatorReply(
  sql: Sql,
  input: GenerateOperatorReplyInput,
): Promise<GenerateOperatorReplyResult> {
  let retryReason: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const prompt = buildOperatorPrompt(input.snapshot, input.ownerText, retryReason);

    // The closure's two outcomes. `invalid_shape` returns THROUGH the guard
    // rather than past it, which is the whole point: the providers billed
    // those completions, so the reservation must finalize against the real
    // spend instead of being released as if nothing ran. Shape copied from
    // src/lib/solicitation/ask-generation.ts:499-528.
    type GuardedCall =
      | { kind: 'ok'; llm: LLMCallResult; output: ModelOutput }
      | { kind: 'invalid_shape' };

    const guarded = await withCostGuard<GuardedCall>(
      {
        businessId: input.locationId,
        subscriptionTier: input.subscriptionTier,
        // false, matching the judge: an Operator turn is owner-initiated and
        // rare, and a per-business concurrency slot would make a second turn
        // wait behind the first for no safety benefit.
        withConcurrency: false,
        onFinalizeError: 'log-and-return-value',
      },
      async () => {
        const startedAt = Date.now();
        try {
          const llm = await runLlmTask('owner_operator', prompt);
          const latencyMs = Date.now() - startedAt;
          const output = OperatorModelOutputSchema.parse(llm.structured);
          const costUsd = calculateCostUsd(llm.model, llm.usage.promptTokens, llm.usage.completionTokens);
          await tryRecordOperatorCost(sql, input, llm, costUsd, latencyMs);
          return {
            value: { kind: 'ok' as const, llm, output },
            actualCostCents: Math.ceil(costUsd * 100),
          };
        } catch (error) {
          // Terminal for THIS attempt, but every completion on the error was
          // BILLED — only the shape was wrong. Sum them, audit each, and let
          // the guard finalize. latencyMs is the whole guarded call; the error
          // carries no per-attempt timing.
          if (!(error instanceof LLMStructuredOutputError)) throw error;
          const latencyMs = Date.now() - startedAt;
          let totalUsd = 0;
          for (const billed of error.billedAttempts) {
            const costUsd = calculateCostUsd(
              billed.model,
              billed.usage.promptTokens,
              billed.usage.completionTokens,
            );
            totalUsd += costUsd;
            await tryRecordOperatorCost(
              sql,
              input,
              { provider: billed.provider, model: billed.model, usage: billed.usage },
              costUsd,
              latencyMs,
            );
          }
          return {
            value: { kind: 'invalid_shape' as const },
            actualCostCents: Math.ceil(totalUsd * 100),
          };
        }
      },
    );

    if (guarded.kind === 'invalid_shape') {
      // The seam's own shape failure IS validation failure #1.
      retryReason = 'the previous output did not match the required JSON schema';
      logger.warn('owner_operator structured output invalid', {
        turn_id: input.turnId,
        attempt,
      });
      continue;
    }

    const validated = validateModelOutput(guarded.output, input.snapshot);
    if (validated.ok) {
      return {
        ok: true,
        output: validated.output,
        proposals: validated.proposals,
        restoreRequests: validated.restoreRequests,
        attempts: attempt,
      };
    }

    retryReason = validated.reasons.join('; ');
    logger.warn('owner_operator output rejected by validator', {
      turn_id: input.turnId,
      attempt,
      reason_count: validated.reasons.length,
      // The shared logger retains scalars but drops arrays.
      rejection_codes: semanticRejectionCodes(validated.reasons).join(','),
    });
  }

  return { ok: false, reason: 'model_output_invalid', attempts: MAX_ATTEMPTS };
}
