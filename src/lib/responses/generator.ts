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
  reserveCost,
  acquireConcurrencySlot,
  finalizeCost,
  setCachedGeneration,
  releaseCost,
  releaseConcurrencySlot,
} from '@/lib/costs/tracker';
import { recordApiCost, calculateCostUsd } from '@/lib/costs/audit';

// Re-export error classes so callers can import from one place
export {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
} from '@/lib/costs/tracker';

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
  // skipCache is used by the avoid-facts retry so a cached violating
  // response doesn't short-circuit the regeneration.
  if (!options.skipCache) {
    const cached = await checkIdempotentCache(reviewId, version);
    if (cached) {
      const parsed: CachedGeneration = JSON.parse(cached);
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

  // Phase 1: Reserve cost + acquire concurrency
  const reservationDate = await reserveCost(businessId, subscriptionTier);

  let concurrencyAcquired = false;
  let finalized = false;
  try {
    await acquireConcurrencySlot(businessId);
    concurrencyAcquired = true;

    const prompt = buildProductionPrompt(review, business, voiceExamples);
    const llmResult = await callLLMWithFallback(prompt.systemPrompt, prompt.userPrompt);

    const costUsd = calculateCostUsd(
      llmResult.model,
      llmResult.usage.promptTokens,
      llmResult.usage.completionTokens,
    );
    const actualCostCents = Math.ceil(costUsd * 100);

    // Phase 2: Finalize — once finalized, NEVER refund even if later steps fail
    await finalizeCost(businessId, actualCostCents, reservationDate);
    finalized = true;

    // Detect language from the response text (more reliable than review detection
    // for short reviews where franc defaults to 'en')
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

    // Post-finalization bookkeeping: best-effort, must not throw.
    // If cache write fails, a retry will re-generate (bounded by daily limit).
    // If audit write fails, hourly reconciliation catches the gap.
    // Skip cache write when skipCache is set (avoid-facts retry) — the caller
    // will cache the final accepted result via a normal call.
    if (!options.skipCache) {
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

    try {
      result.apiCostId = await recordApiCost({
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
    }

    return result;
  } finally {
    // Cleanup is best-effort — Redis TTLs are the safety net.
    // Must not throw, or it would mask the real error / discard the result.
    if (concurrencyAcquired) {
      try {
        await releaseConcurrencySlot(businessId);
      } catch (err) {
        console.error('[generator] Failed to release concurrency slot:', err);
      }
    }
    if (!finalized) {
      try {
        await releaseCost(businessId, reservationDate);
      } catch (err) {
        console.error('[generator] Failed to release cost reservation:', err);
      }
    }
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
    return callAnthropic(systemPrompt, userPrompt);
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

  const block = response.content[0];
  if (!block || block.type !== 'text') {
    throw new Error('Anthropic returned empty response');
  }

  return {
    text: block.text,
    provider: 'anthropic',
    model: ANTHROPIC_MODEL,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
  };
}
