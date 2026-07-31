import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { llmCircuitBreaker } from '@/lib/llm/circuit-breaker';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationOptions } from '../types';

// generateResponse now takes an injected `sql` as its leading arg; in these
// tests it is only forwarded to the mocked recordApiCost, so a bare stub
// suffices (demo/production paths never issue a real query through it).
const mockSql = {} as unknown as Sql;

// ── Mock all external dependencies ───────────────────────────────────

const openaiCreate = vi.fn();
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: openaiCreate } };
    },
  };
});

const anthropicCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: anthropicCreate };
    },
  };
});

vi.mock('@/lib/reviews/detect-language', () => ({
  detectResponseLanguage: vi.fn().mockReturnValue('en'),
}));

vi.mock('@/lib/costs/tracker', () => ({
  checkIdempotentCache: vi.fn().mockResolvedValue(null),
  reserveCost: vi.fn().mockResolvedValue('2025-06-15'),
  finalizeCost: vi.fn().mockResolvedValue(undefined),
  setCachedGeneration: vi.fn().mockResolvedValue(undefined),
  releaseCost: vi.fn().mockResolvedValue(undefined),
  CostLimitExceededError: class CostLimitExceededError extends Error {
    name = 'CostLimitExceededError';
    constructor(public readonly businessId: string) {
      super(`Daily cost limit exceeded for business ${businessId}`);
    }
  },
  GlobalCostLimitExceededError: class GlobalCostLimitExceededError extends Error {
    name = 'GlobalCostLimitExceededError';
    constructor() { super('Global daily cost limit exceeded'); }
  },
  RegenBudgetExceededError: class RegenBudgetExceededError extends Error {
    name = 'RegenBudgetExceededError';
    constructor(public readonly reviewId: string) {
      super(`Regeneration budget exceeded for review ${reviewId}`);
    }
  },
}));

vi.mock('@/lib/costs/concurrency-guard', () => ({
  acquireConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  releaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  ConcurrencyLimitExceededError: class ConcurrencyLimitExceededError extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) {
      super(`Concurrency limit exceeded for business ${businessId}`);
    }
  },
}));

vi.mock('@/lib/costs/cost-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/costs/cost-guard')>('@/lib/costs/cost-guard');
  return actual;
});

vi.mock('@/lib/costs/audit', () => ({
  recordApiCost: vi.fn().mockResolvedValue('cost-uuid-001'),
  calculateCostUsd: vi.fn().mockReturnValue(0.000_123),
}));

// ── Helpers ──────────────────────────────────────────────────────────

function openAIResponse(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

function anthropicResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const review: NormalizedReview = {
  reviewerName: 'Jane Doe',
  starRating: 5,
  reviewText: 'Great food and service.',
  reviewDate: '2025-03-15T14:30:00Z',
  detectedLanguage: 'en',
};

const demoOptions: GenerationOptions = { mode: 'demo' };

const productionOptions: GenerationOptions = {
  mode: 'production',
  reviewId: 'rev-001',
  version: 1,
  businessId: 'biz-001',
  subscriptionTier: 'copilot',
  accountId: 'acc-001',
};

const businessContext = {
  id: 'biz-001',
  name: 'Test Restaurant',
  category: 'restaurant',
  tone: 'warm and appreciative',
  productsServices: null,
  staffNames: [],
  highlightFacts: [],
  avoidFacts: [],
  sampleResponses: [],
  subscriptionTier: 'copilot' as const,
};

// ── Tests ────────────────────────────────────────────────────────────

describe('generateResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // This suite mocks the raw SDKs but drives the REAL runLlmTask + live
    // breaker singleton; without a reset, transient rejections accumulate
    // across tests and could trip the breaker mid-file (order-dependent).
    llmCircuitBreaker.reset();
  });

  it('calls OpenAI as primary provider', async () => {
        openaiCreate.mockResolvedValueOnce(openAIResponse('Thank you, Jane!'));

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(mockSql, review, businessContext, [], demoOptions);

    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini-2024-07-18');
    expect(result.responseText).toBe('Thank you, Jane!');
    expect(openaiCreate).toHaveBeenCalledOnce();
  });

  it('falls back to Anthropic when OpenAI fails', async () => {
        
    openaiCreate.mockRejectedValueOnce(new Error('OpenAI rate limit'));
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('Merci, Jane!'));

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(mockSql, review, businessContext, [], demoOptions);

    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.responseText).toBe('Merci, Jane!');
  });

  it('throws when both providers fail', async () => {
        
    openaiCreate.mockRejectedValueOnce(new Error('OpenAI down'));
    anthropicCreate.mockRejectedValueOnce(new Error('Anthropic down'));

    const { generateResponse } = await import('../generator');
    await expect(
      generateResponse(mockSql, review, businessContext, [], demoOptions),
    ).rejects.toThrow('Anthropic down');
  });

  it('returns correct usage mapping from OpenAI', async () => {
        openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(mockSql, review, businessContext, [], demoOptions);

    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
  });

  it('returns correct usage mapping from Anthropic', async () => {
        
    openaiCreate.mockRejectedValueOnce(new Error('fail'));
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('Thanks!'));

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(mockSql, review, businessContext, [], demoOptions);

    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
  });

  it('demo mode skips cost guard calls', async () => {
        openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const tracker = await import('@/lib/costs/tracker');
    const concurrencyGuard = await import('@/lib/costs/concurrency-guard');
    const audit = await import('@/lib/costs/audit');
    const { generateResponse } = await import('../generator');
    await generateResponse(mockSql, review, businessContext, [], demoOptions);

    expect(tracker.reserveCost).not.toHaveBeenCalled();
    expect(concurrencyGuard.acquireConcurrencySlot).not.toHaveBeenCalled();
    expect(tracker.finalizeCost).not.toHaveBeenCalled();
    expect(audit.recordApiCost).not.toHaveBeenCalled();
  });

  it('production mode runs full cost guard lifecycle', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const tracker = await import('@/lib/costs/tracker');
    const concurrencyGuard = await import('@/lib/costs/concurrency-guard');
    const audit = await import('@/lib/costs/audit');
    const { generateResponse } = await import('../generator');
    await generateResponse(mockSql, review, businessContext, [], productionOptions);

    // Trailing undefined = estimateCents omitted, the 15¢ default (#628).
    expect(tracker.reserveCost).toHaveBeenCalledWith('biz-001', 'copilot', undefined);
    expect(concurrencyGuard.acquireConcurrencySlot).toHaveBeenCalledWith('biz-001');
    expect(tracker.finalizeCost).toHaveBeenCalled();
    expect(concurrencyGuard.releaseConcurrencySlot).toHaveBeenCalledWith('biz-001');
    expect(tracker.setCachedGeneration).toHaveBeenCalled();
    expect(audit.recordApiCost).toHaveBeenCalled();
  });

  it('records prompt metadata, latency, and account_id in api_costs (production)', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const audit = await import('@/lib/costs/audit');
    const { generateResponse } = await import('../generator');
    await generateResponse(mockSql, review, businessContext, [], productionOptions);

    expect(audit.recordApiCost).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        accountId: 'acc-001',
        promptVersion: expect.any(String),
        systemPromptHash: expect.any(String),
        latencyMs: expect.any(Number),
      }),
    );
  });

  it('returns cached result with costUsd 0 on cache hit', async () => {
    const tracker = await import('@/lib/costs/tracker');
    vi.mocked(tracker.checkIdempotentCache).mockResolvedValueOnce(
      JSON.stringify({
        responseText: 'Cached response',
        language: 'en',
        provider: 'openai',
        model: 'gpt-4o-mini',
        promptTokens: 80,
        completionTokens: 40,
      }),
    );

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(mockSql, review, businessContext, [], productionOptions);

    expect(result.responseText).toBe('Cached response');
    expect(result.costUsd).toBe(0);
    expect(tracker.reserveCost).not.toHaveBeenCalled();
  });

  it('throws TypeError when production mode missing reviewId', async () => {
    const { generateResponse } = await import('../generator');
    const opts: GenerationOptions = { mode: 'production', version: 1, businessId: 'b', subscriptionTier: 'copilot' };

    await expect(
      generateResponse(mockSql, review, businessContext, [], opts),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError when production mode missing businessId', async () => {
    const { generateResponse } = await import('../generator');
    const opts: GenerationOptions = { mode: 'production', reviewId: 'r', version: 1, subscriptionTier: 'copilot' };

    await expect(
      generateResponse(mockSql, review, businessContext, [], opts),
    ).rejects.toThrow(TypeError);
  });

  it('releases concurrency slot and cost on LLM failure in production', async () => {
            openaiCreate.mockRejectedValueOnce(new Error('fail'));
    anthropicCreate.mockRejectedValueOnce(new Error('also fail'));

    const tracker = await import('@/lib/costs/tracker');
    const concurrencyGuard = await import('@/lib/costs/concurrency-guard');
    const { generateResponse } = await import('../generator');

    await expect(
      generateResponse(mockSql, review, businessContext, [], productionOptions),
    ).rejects.toThrow();

    expect(concurrencyGuard.releaseConcurrencySlot).toHaveBeenCalledWith('biz-001');
    expect(tracker.releaseCost).toHaveBeenCalledWith('biz-001', '2025-06-15', undefined);
  });

  it('throws TypeError when production mode receives demo-shaped context', async () => {
    const { generateResponse } = await import('../generator');
    const demoCtx = { name: 'Test', category: 'restaurant' };

    await expect(
      generateResponse(mockSql, review, demoCtx, [], productionOptions),
    ).rejects.toThrow(TypeError);
  });

  it('still returns result when post-finalization cache write fails', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const tracker = await import('@/lib/costs/tracker');
    vi.mocked(tracker.setCachedGeneration).mockRejectedValueOnce(
      new Error('Redis timeout'),
    );

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(mockSql, review, businessContext, [], productionOptions);

    expect(result.responseText).toBe('Thanks!');
    expect(tracker.finalizeCost).toHaveBeenCalled();
  });

  it('releases cost reservation when concurrency slot acquisition fails', async () => {
    const tracker = await import('@/lib/costs/tracker');
    const concurrencyGuard = await import('@/lib/costs/concurrency-guard');
    vi.mocked(concurrencyGuard.acquireConcurrencySlot).mockRejectedValueOnce(
      new Error('Concurrency limit exceeded'),
    );

    const { generateResponse } = await import('../generator');
    await expect(
      generateResponse(mockSql, review, businessContext, [], productionOptions),
    ).rejects.toThrow('Concurrency limit exceeded');

    expect(tracker.releaseCost).toHaveBeenCalledWith('biz-001', '2025-06-15', undefined);
    expect(concurrencyGuard.releaseConcurrencySlot).not.toHaveBeenCalled();
  });

  it('returns result even when wrapper cleanup throws', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Good response'));

    const concurrencyGuard = await import('@/lib/costs/concurrency-guard');
    vi.mocked(concurrencyGuard.releaseConcurrencySlot).mockRejectedValueOnce(
      new Error('Redis connection lost'),
    );

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(mockSql, review, businessContext, [], productionOptions);

    expect(result.responseText).toBe('Good response');
  });

  it('finalizeCost error is logged and the draft is still returned (no terminal draft loss); reservation ages out via TTL, slot released, cache + audit reached', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const tracker = await import('@/lib/costs/tracker');
    const concurrencyGuard = await import('@/lib/costs/concurrency-guard');
    const audit = await import('@/lib/costs/audit');
    const finalizeErr = new Error('Redis timeout during finalize');
    vi.mocked(tracker.finalizeCost).mockRejectedValueOnce(finalizeErr);

    // The LLM already succeeded and the draft was cached inside the wrapper, so a
    // finalize-time Redis flake must NOT discard the paid-for draft (that would
    // lose the owner's notification while the spend already happened). The
    // generation path uses onFinalizeError:'log-and-return-value', so the error
    // is logged and the draft is returned. (Was: propagated → terminal draft loss.)
    const { generateResponse } = await import('../generator');
    const result = await generateResponse(mockSql, review, businessContext, [], productionOptions);
    expect(result.responseText).toBe('Thanks!');

    // releaseCost only fires when !finalized; the finalize attempt sets
    // finalized=true, so the reservation is intentionally left to age out via
    // the 24h Redis TTL rather than double-adjusted.
    expect(tracker.releaseCost).not.toHaveBeenCalled();
    expect(concurrencyGuard.releaseConcurrencySlot).toHaveBeenCalledWith('biz-001');
    // Cache write happens INSIDE the wrapper closure (before finalize) per M3.
    expect(tracker.setCachedGeneration).toHaveBeenCalled();
    // The wrapper now RETURNS the value, so the post-wrapper audit path runs.
    expect(audit.recordApiCost).toHaveBeenCalled();
  });

  it('finalizeCost transient-shaped error does not propagate — draft still returned', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const tracker = await import('@/lib/costs/tracker');
    const finalizeErr = Object.assign(new Error('ECONNRESET during finalize'), { code: 'ECONNRESET' });
    vi.mocked(tracker.finalizeCost).mockRejectedValueOnce(finalizeErr);

    const { generateResponse } = await import('../generator');

    // Regardless of the finalize error's shape, the paid-for draft is returned,
    // not lost. (Was: asserted propagation as a plain Error.)
    const result = await generateResponse(mockSql, review, businessContext, [], productionOptions);
    expect(result.responseText).toBe('Thanks!');
  });

  // M4 regression: when only ONE provider's failure is transient, the
  // TransientLLMError must wrap the actually-transient one. Otherwise the
  // worker would retry forever against a permanent failure (e.g. anthropic
  // 401 after openai 503) and observability would point at the wrong cause.

  it('wraps openai cause when openai is transient + anthropic is permanent', async () => {
    const openaiTransient = Object.assign(new Error('openai 503'), { code: 'ECONNRESET' });
    const anthropicPermanent = Object.assign(new Error('anthropic auth failed'), { name: 'AuthenticationError' });

    openaiCreate.mockRejectedValueOnce(openaiTransient);
    anthropicCreate.mockRejectedValueOnce(anthropicPermanent);

    const { generateResponse } = await import('../generator');
    const { TransientLLMError } = await import('@/lib/llm/error-classifier');

    try {
      await generateResponse(mockSql, review, businessContext, [], demoOptions);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransientLLMError);
      expect((err as InstanceType<typeof TransientLLMError>).cause).toBe(openaiTransient);
    }
  });

  it('wraps anthropic cause when anthropic is transient + openai is permanent', async () => {
    const openaiPermanent = Object.assign(new Error('openai bad request'), { name: 'BadRequestError' });
    const anthropicTransient = Object.assign(new Error('anthropic timeout'), { code: 'ETIMEDOUT' });

    openaiCreate.mockRejectedValueOnce(openaiPermanent);
    anthropicCreate.mockRejectedValueOnce(anthropicTransient);

    const { generateResponse } = await import('../generator');
    const { TransientLLMError } = await import('@/lib/llm/error-classifier');

    try {
      await generateResponse(mockSql, review, businessContext, [], demoOptions);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransientLLMError);
      expect((err as InstanceType<typeof TransientLLMError>).cause).toBe(anthropicTransient);
    }
  });

  it('wraps anthropic cause when both are transient (preserves prior behavior)', async () => {
    const openaiTransient = Object.assign(new Error('openai 503'), { code: 'ECONNRESET' });
    const anthropicTransient = Object.assign(new Error('anthropic timeout'), { code: 'ETIMEDOUT' });

    openaiCreate.mockRejectedValueOnce(openaiTransient);
    anthropicCreate.mockRejectedValueOnce(anthropicTransient);

    const { generateResponse } = await import('../generator');
    const { TransientLLMError } = await import('@/lib/llm/error-classifier');

    try {
      await generateResponse(mockSql, review, businessContext, [], demoOptions);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransientLLMError);
      // When both are transient, prefer anthropic (the most recent attempt)
      // to match prior behavior — caller still sees a transient retry signal.
      expect((err as InstanceType<typeof TransientLLMError>).cause).toBe(anthropicTransient);
    }
  });
});
