import { v7 as uuidv7 } from 'uuid';
import type { Sql } from 'postgres';

// ── Model pricing ────────────────────────────────────────────────────

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Pinned snapshot used for production generation (see @/lib/llm/tasks OPENAI_MODEL).
  'gpt-4o-mini-2024-07-18': { inputPer1M: 0.15, outputPer1M: 0.60 },
  // Bare alias retained only so calculateCostUsd still resolves historical rows.
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
  'claude-haiku-4-5-20251001': { inputPer1M: 0.80, outputPer1M: 4.00 },
};

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) throw new Error(`Unknown model for pricing: ${model}`);

  const cost =
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M;

  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ── Audit trail ─────────────────────────────────────────��────────────

/**
 * Single owner of the `api_costs.endpoint` label written by the
 * response-generation path (`tryRecordApiCost` in
 * `src/lib/responses/generator.ts`, both the primary draft and the
 * avoid-facts retry). `src/lib/admin/margin-service.ts` imports this same
 * constant on read to find rows that SHOULD have gotten `response_id` linked
 * by `worker/jobs/response-generation/persist.ts` but didn't because the
 * persist transaction aborted (#1106) — orphaned honest spend, kept in the
 * margin totals and broken out as a separate line.
 *
 * Every other `recordApiCost` caller (judge, review-summary, triage,
 * safety-review, owner-operator, solicitation ask-generation, serpapi
 * prefill) already writes its own distinct semantic endpoint label and is
 * never linked to a `responses` row by design — this constant exists so the
 * one path that IS meant to be linked stays unambiguous from all of them.
 */
export const RESPONSE_GENERATION_ENDPOINT = 'response-generation';

/**
 * Inserts an api_costs audit row and returns the row's UUID.
 *
 * `accountId` should be set for business-scoped production calls (margin
 * rollups depend on it); platform-level calls leave it null. Prompt metadata
 * and latency are recorded for production LLM generations.
 */
export async function recordApiCost(sql: Sql, params: {
  businessId: string | null;
  accountId?: string | null;
  provider: string;
  endpoint: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  responseId: string | null;
  systemPromptHash?: string | null;
  promptVersion?: string | null;
  latencyMs?: number | null;
}): Promise<string> {
  const id = uuidv7();
  await sql`
    INSERT INTO api_costs (
      id, business_id, account_id, provider, endpoint,
      input_tokens, output_tokens, cost_usd, response_id,
      system_prompt_hash, prompt_version, latency_ms
    )
    VALUES (
      ${id},
      ${params.businessId},
      ${params.accountId ?? null},
      ${params.provider},
      ${params.endpoint},
      ${params.inputTokens},
      ${params.outputTokens},
      ${params.costUsd},
      ${params.responseId},
      ${params.systemPromptHash ?? null},
      ${params.promptVersion ?? null},
      ${params.latencyMs ?? null}
    )
  `;
  return id;
}
