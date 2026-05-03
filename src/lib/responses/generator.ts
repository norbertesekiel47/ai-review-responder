import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { NormalizedReview } from '@/lib/reviews/types';
import { detectResponseLanguage } from '@/lib/reviews/detect-language';
import type {
  BusinessContext,
  DemoBusinessContext,
  VoiceExample,
  GenerationOptions,
  GenerationResult,
} from './types';
import { buildDemoPrompt, buildProductionPrompt } from './prompt-builder';
import {
  checkIdempotentCache,
  clearCachedGeneration,
  setCachedGeneration,
} from '@/lib/costs/tracker';
import { withCostGuard } from '@/lib/costs/cost-guard';
import { recordApiCost, calculateCostUsd } from '@/lib/costs/audit';

// Re-export error classes so callers can import from one place
export {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
} from '@/lib/costs/tracker';
export { TransientLLMError } from './llm-error-classifier';

// ── Constants ────────────────────────────────────────────────────────

const OPENAI_MODEL = 'gpt-4o-mini' as const;
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001' as const;
const LLM_TEMPERATURE = 0.7;
const LLM_MAX_TOKENS = 300;

// ── Cached generation shape (stored in Redis) ────────────────────────

interface CachedGeneration {
  responseText: string;
  language: string;
  provider: 'openai' | 'anthropic';
  model: string;
  promptTokens: number;
  completionTokens: number;
}

import { isTransientLLMError, TransientLLMError } from './llm-error-classifier';

// ── Type guard ───────────────────────────────────────────────────────

function isBusinessContext(
  ctx: DemoBusinessContext | BusinessContext,
): ctx is BusinessContext {
  return 'id' in ctx && 'tone' in ctx;
}

// ── Main entry point ─────────────────────────────────────────────────

export async function generateResponse(
  review: NormalizedReview,
  businessContext: DemoBusinessContext | BusinessContext,
  voiceExamples: VoiceExample[],
  options: GenerationOptions,
): Promise<GenerationResult> {
  if (options.mode === 'demo') {
    return runDemoMode(review, businessContext, options);
  }

  if (!isBusinessContext(businessContext)) {
    throw new TypeError(
      'Production mode requires full BusinessContext (id, tone, staffNames, etc.)',
    );
  }

  return runProductionMode(review, businessContext, voiceExamples, options);
}

// ── Demo mode (no cost guard, no caching) ────────────────────────────

async function runDemoMode(
  review: NormalizedReview,
  businessContext: DemoBusinessContext,
  _options: GenerationOptions,
): Promise<GenerationResult> {
  const prompt = buildDemoPrompt(
    review,
    businessContext.name,
    businessContext.category,
  );

  const llmResult = await callLLMWithFallback(prompt.systemPrompt, prompt.userPrompt);

  return {
    responseText: llmResult.text,
    language: detectResponseLanguage(llmResult.text),
    provider: llmResult.provider,
    model: llmResult.model,
    usage: llmResult.usage,
    costUsd: calculateCostUsd(
      llmResult.model,
      llmResult.usage.promptTokens,
      llmResult.usage.completionTokens,
    ),
    apiCostId: null,
  };
}

// ── Production mode (full cost guard lifecycle) ──────────────────────

function validateProductionOptions(
  options: GenerationOptions,
): asserts options is GenerationOptions &
  Required<Pick<GenerationOptions, 'reviewId' | 'version' | 'businessId' | 'subscriptionTier'>> {
  if (!options.reviewId) throw new TypeError('reviewId is required in production mode');
  if (options.version == null) throw new TypeError('version is required in production mode');
  if (!options.businessId) throw new TypeError('businessId is required in production mode');
  if (!options.subscriptionTier) throw new TypeError('subscriptionTier is required in production mode');
}

async function runProductionMode(
  review: NormalizedReview,
  business: BusinessContext,
  voiceExamples: VoiceExample[],
  options: GenerationOptions,
): Promise<GenerationResult> {
  validateProductionOptions(options);
  const { reviewId, version, businessId, subscriptionTier } = options;

  // Check idempotent cache — return immediately if already generated.
  if (!options.skipCache) {
    const cached = await checkIdempotentCache(reviewId, version);
    if (cached) {
      const parsed = tryParseCachedGeneration(cached, reviewId, version);
      if (parsed) {
        return {
          responseText: parsed.responseText,
          language: parsed.language,
          provider: parsed.provider,
          model: parsed.model,
          usage: {
            promptTokens: parsed.promptTokens,
            completionTokens: parsed.completionTokens,
          },
          costUsd: 0,
          apiCostId: null,
        };
      }
    }
  }

  const { llmResult, costUsd } = await withCostGuard(
    { businessId, subscriptionTier, withConcurrency: true },
    async () => {
      const prompt = buildProductionPrompt(review, business, voiceExamples);
      const llm = await callLLMWithFallback(prompt.systemPrompt, prompt.userPrompt);
      const usd = calculateCostUsd(
        llm.model,
        llm.usage.promptTokens,
        llm.usage.completionTokens,
      );
      return { value: { llmResult: llm, costUsd: usd }, actualCostCents: Math.ceil(usd * 100) };
    },
  );

  const responseLanguage = detectResponseLanguage(llmResult.text);
  const result: GenerationResult = {
    responseText: llmResult.text,
    language: responseLanguage,
    provider: llmResult.provider,
    model: llmResult.model,
    usage: llmResult.usage,
    costUsd,
    apiCostId: null,
  };

  if (!options.skipCache) {
    await tryWriteCache(reviewId, version, llmResult, responseLanguage);
  }
  result.apiCostId = await tryRecordApiCost(businessId, llmResult, costUsd);

  return result;
}

// ── Best-effort helpers for runProductionMode ────────────────────────

function tryParseCachedGeneration(
  cached: string,
  reviewId: string,
  version: number,
): CachedGeneration | null {
  try {
    return JSON.parse(cached) as CachedGeneration;
  } catch (err) {
    console.warn(
      `[generator] Corrupt cached generation for ${reviewId} v${version}: ${err instanceof Error ? err.message : err}`,
    );
    clearCachedGeneration(reviewId, version).catch(() => { /* best effort */ });
    return null;
  }
}

async function tryWriteCache(
  reviewId: string,
  version: number,
  llmResult: { text: string; provider: 'openai' | 'anthropic'; model: string; usage: { promptTokens: number; completionTokens: number } },
  responseLanguage: string,
): Promise<void> {
  try {
    const cachePayload: CachedGeneration = {
      responseText: llmResult.text,
      language: responseLanguage,
      provider: llmResult.provider,
      model: llmResult.model,
      promptTokens: llmResult.usage.promptTokens,
      completionTokens: llmResult.usage.completionTokens,
    };
    await setCachedGeneration(reviewId, version, JSON.stringify(cachePayload));
  } catch (cacheError) {
    console.error('[generator] Failed to cache generation result:', cacheError);
  }
}

async function tryRecordApiCost(
  businessId: string,
  llmResult: { provider: 'openai' | 'anthropic'; usage: { promptTokens: number; completionTokens: number } },
  costUsd: number,
): Promise<string | null> {
  try {
    return await recordApiCost({
      businessId,
      provider: llmResult.provider,
      endpoint: llmResult.provider === 'openai' ? 'chat.completions' : 'messages',
      inputTokens: llmResult.usage.promptTokens,
      outputTokens: llmResult.usage.completionTokens,
      costUsd,
      responseId: null,
    });
  } catch (auditError) {
    console.error('[generator] Failed to record api_costs audit row:', auditError);
    return null;
  }
}

// ── LLM client lazy singletons ──────────────────────────────────────

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

// ── LLM call with OpenAI → Anthropic fallback ───────────────────────

interface LLMCallResult {
  text: string;
  provider: 'openai' | 'anthropic';
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

async function callLLMWithFallback(
  systemPrompt: string,
  userPrompt: string,
): Promise<LLMCallResult> {
  try {
    return await callOpenAI(systemPrompt, userPrompt);
  } catch (openaiError) {
    console.error('[generator] OpenAI call failed, falling back to Anthropic:', openaiError);
    try {
      return await callAnthropic(systemPrompt, userPrompt);
    } catch (anthropicError) {
      // Both providers failed. If either failure is transient (network, 5xx,
      // rate-limit, timeout), surface as TransientLLMError so the worker
      // rethrows for BullMQ/outbox retry instead of terminal-failing work
      // that a provider outage would otherwise lose.
      if (isTransientLLMError(openaiError) || isTransientLLMError(anthropicError)) {
        throw new TransientLLMError(anthropicError);
      }
      throw anthropicError;
    }
  }
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
): Promise<LLMCallResult> {
  const client = getOpenAI();
  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: LLM_TEMPERATURE,
    max_tokens: LLM_MAX_TOKENS,
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned empty response');

  return {
    text,
    provider: 'openai',
    model: OPENAI_MODEL,
    usage: {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
): Promise<LLMCallResult> {
  const client = getAnthropic();
  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: LLM_MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content
    .filter((b): b is { type: 'text'; text: string } & typeof b => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  if (!text) {
    throw new Error('Anthropic returned empty response');
  }

  return {
    text,
    provider: 'anthropic',
    model: ANTHROPIC_MODEL,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
  };
}
