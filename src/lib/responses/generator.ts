import type { Sql } from 'postgres';
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
import { PROMPT_VERSION, systemPromptHash } from './prompt-policy';
import { runLlmTask } from '@/lib/llm/run-task';
import type { LLMCallResult } from '@/lib/llm/types';

// ── Cached generation shape (stored in Redis) ────────────────────────

interface CachedGeneration {
  responseText: string;
  language: string;
  provider: 'openai' | 'anthropic';
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** ADR 0017 provenance: the review_content_hash the generating attempt
   *  loaded (null for legacy pre-hash reviews). Binds cache identity to
   *  CONTENT — the (reviewId, version) key alone cannot, because live-ingest's
   *  content-change replacement job shares the in-flight version. */
  reviewContentHash: string | null;
}

// ── Type guard ───────────────────────────────────────────────────────

function isBusinessContext(
  ctx: DemoBusinessContext | BusinessContext,
): ctx is BusinessContext {
  return 'id' in ctx && 'tone' in ctx;
}

// ── Main entry point ─────────────────────────────────────────────────

export async function generateResponse(
  sql: Sql,
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

  return runProductionMode(sql, review, businessContext, voiceExamples, options);
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

  const llmResult = await runLlmTask('reply_generation', {
    system: prompt.systemPrompt,
    user: prompt.userPrompt,
  });

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
  Required<Pick<GenerationOptions, 'reviewId' | 'version' | 'businessId' | 'subscriptionTier' | 'accountId'>> {
  if (!options.reviewId) throw new TypeError('reviewId is required in production mode');
  if (options.version == null) throw new TypeError('version is required in production mode');
  if (!options.businessId) throw new TypeError('businessId is required in production mode');
  if (!options.subscriptionTier) throw new TypeError('subscriptionTier is required in production mode');
  if (!options.accountId) throw new TypeError('accountId is required in production mode');
}

async function runProductionMode(
  sql: Sql,
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
        // ADR 0017: cache identity must bind to CONTENT, not just
        // (reviewId, version) — live-ingest's content-change replacement job
        // deliberately shares the in-flight version, so a draft cached against
        // hash H1 would otherwise be served to a replacement attempt that
        // loaded H2, whose content-freshness gate then sees H2 == H2 and
        // persists the stale text. Accept ONLY on STRICT equality with this
        // attempt's loaded hash: null === null passes (legacy pre-hash
        // reviews); a provenance-less pre-change entry (undefined) or a
        // mismatched hash is rejected — cleared best-effort (mirroring the
        // corrupt-payload branch) and regenerated fresh.
        if (parsed.reviewContentHash === (options.loadedReviewContentHash ?? null)) {
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
        clearCachedGeneration(reviewId, version).catch(() => { /* best effort */ });
      }
    }
  }

  // M3: Cache write happens INSIDE the wrapper closure (before slot release).
  // If we wrote the cache after the wrapper returned, a second worker for
  // the same (reviewId, version) could pass `checkIdempotentCache` (still
  // empty), acquire a fresh slot, and make a duplicate LLM call. The
  // downstream UNIQUE constraint on responses(review_id, version) ensures
  // only one row lands, but both LLM calls are billed. Keeping the slot
  // held for the cache write (~1 Redis RTT) closes the race; the audit
  // write stays outside because it's pure observability with no race risk.
  const { llmResult, responseLanguage, costUsd, latencyMs } = await withCostGuard(
    // onFinalizeError: 'log-and-return-value' — the LLM call already succeeded
    // and the draft was cached inside this closure (M3 below). A post-LLM Redis
    // (Upstash) flake in finalizeCost must NOT discard the paid-for draft: the
    // raw transport error matches none of the retryable classes in
    // generate-draft.ts, so 'propagate' (the default) would fall through to a
    // terminal generation_failed and silently lose the draft (owner never
    // notified) while the spend already happened. Return the value instead; the
    // reservation ages out via the 24h Redis TTL. Mirrors review-summary.ts.
    { businessId, subscriptionTier, withConcurrency: true, onFinalizeError: 'log-and-return-value' },
    async () => {
      const prompt = buildProductionPrompt(review, business, voiceExamples, options.triageSeverity ?? null);
      const startedAt = Date.now();
      const llm = await runLlmTask('reply_generation', {
        system: prompt.systemPrompt,
        user: prompt.userPrompt,
      });
      const ms = Date.now() - startedAt;
      const usd = calculateCostUsd(
        llm.model,
        llm.usage.promptTokens,
        llm.usage.completionTokens,
      );
      const lang = detectResponseLanguage(llm.text);

      if (!options.skipCache) {
        await tryWriteCache(
          reviewId,
          version,
          llm,
          lang,
          options.loadedReviewContentHash ?? null,
        );
      }

      return {
        value: { llmResult: llm, responseLanguage: lang, costUsd: usd, latencyMs: ms },
        actualCostCents: Math.ceil(usd * 100),
      };
    },
  );

  const result: GenerationResult = {
    responseText: llmResult.text,
    language: responseLanguage,
    provider: llmResult.provider,
    model: llmResult.model,
    usage: llmResult.usage,
    costUsd,
    apiCostId: null,
  };

  result.apiCostId = await tryRecordApiCost(
    sql,
    businessId,
    options.accountId ?? null,
    llmResult,
    costUsd,
    latencyMs,
  );

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
  llmResult: LLMCallResult,
  responseLanguage: string,
  reviewContentHash: string | null,
): Promise<void> {
  try {
    const cachePayload: CachedGeneration = {
      responseText: llmResult.text,
      language: responseLanguage,
      provider: llmResult.provider,
      model: llmResult.model,
      promptTokens: llmResult.usage.promptTokens,
      completionTokens: llmResult.usage.completionTokens,
      reviewContentHash,
    };
    await setCachedGeneration(reviewId, version, JSON.stringify(cachePayload));
  } catch (cacheError) {
    console.error('[generator] Failed to cache generation result:', cacheError);
  }
}

async function tryRecordApiCost(
  sql: Sql,
  businessId: string,
  accountId: string | null,
  llmResult: LLMCallResult,
  costUsd: number,
  latencyMs: number,
): Promise<string | null> {
  try {
    return await recordApiCost(sql, {
      businessId,
      accountId,
      provider: llmResult.provider,
      endpoint: llmResult.provider === 'openai' ? 'chat.completions' : 'messages',
      inputTokens: llmResult.usage.promptTokens,
      outputTokens: llmResult.usage.completionTokens,
      costUsd,
      responseId: null,
      systemPromptHash: systemPromptHash(),
      promptVersion: PROMPT_VERSION,
      latencyMs,
    });
  } catch (auditError) {
    console.error('[generator] Failed to record api_costs audit row:', auditError);
    return null;
  }
}

