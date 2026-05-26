import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';

// ── Model pricing ────────────────────────────────────────────────────

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Pinned snapshot used for production generation (see generator.ts OPENAI_MODEL).
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
 * Inserts an api_costs audit row and returns the row's UUID.
 */
export async function recordApiCost(params: {
  businessId: string | null;
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
