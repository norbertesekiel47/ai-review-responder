import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';

// ── Model pricing ────────────────────────────────────────────────────

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
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
 * Inserts an api_costs audit row. Returns the row's UUID so the worker
 * can later call linkApiCostToResponse() after inserting the response row.
 */
export async function recordApiCost(params: {
  businessId: string;
  provider: string;
  endpoint: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  responseId: string | null;
}): Promise<string> {
  const id = uuidv7();
  await sql`
    INSERT INTO api_costs (id, business_id, provider, endpoint, input_tokens, output_tokens, cost_usd, response_id)
    VALUES (
      ${id},
      ${params.businessId},
      ${params.provider},
      ${params.endpoint},
      ${params.inputTokens},
      ${params.outputTokens},
      ${params.costUsd},
      ${params.responseId}
    )
  `;
  return id;
}

/**
 * Links an api_costs row to a response after the response row is inserted.
 * Called by the worker after generating + inserting the response in the same transaction.
 */
export async function linkApiCostToResponse(
  apiCostId: string,
  responseId: string,
): Promise<void> {
  await sql`
    UPDATE api_costs SET response_id = ${responseId} WHERE id = ${apiCostId}
  `;
}
