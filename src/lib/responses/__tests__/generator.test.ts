import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationOptions } from '../types';

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
  acquireConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  finalizeCost: vi.fn().mockResolvedValue(undefined),
  setCachedGeneration: vi.fn().mockResolvedValue(undefined),
  releaseCost: vi.fn().mockResolvedValue(undefined),
  releaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  recordApiCost: vi.fn().mockResolvedValue('cost-uuid-001'),
  calculateCostUsd: vi.fn().mockReturnValue(0.000_123),
  CostLimitExceededError: class extends Error { name = 'CostLimitExceededError'; },
  GlobalCostLimitExceededError: class extends Error { name = 'GlobalCostLimitExceededError'; },
  ConcurrencyLimitExceededError: class extends Error { name = 'ConcurrencyLimitExceededError'; },
  RegenBudgetExceededError: class extends Error { name = 'RegenBudgetExceededError'; },
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
  subscriptionTier: 'standard',
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
  subscriptionTier: 'standard' as const,
};

// ── Tests ────────────────────────────────────────────────────────────

describe('generateResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls OpenAI as primary provider', async () => {
        openaiCreate.mockResolvedValueOnce(openAIResponse('Thank you, Jane!'));

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(review, businessContext, [], demoOptions);

    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.responseText).toBe('Thank you, Jane!');
    expect(openaiCreate).toHaveBeenCalledOnce();
  });

  it('falls back to Anthropic when OpenAI fails', async () => {
        
    openaiCreate.mockRejectedValueOnce(new Error('OpenAI rate limit'));
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('Merci, Jane!'));

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(review, businessContext, [], demoOptions);

    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.responseText).toBe('Merci, Jane!');
  });

  it('throws when both providers fail', async () => {
        
    openaiCreate.mockRejectedValueOnce(new Error('OpenAI down'));
    anthropicCreate.mockRejectedValueOnce(new Error('Anthropic down'));

    const { generateResponse } = await import('../generator');
    await expect(
      generateResponse(review, businessContext, [], demoOptions),
    ).rejects.toThrow('Anthropic down');
  });

  it('returns correct usage mapping from OpenAI', async () => {
        openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(review, businessContext, [], demoOptions);

    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
  });

  it('returns correct usage mapping from Anthropic', async () => {
        
    openaiCreate.mockRejectedValueOnce(new Error('fail'));
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('Thanks!'));

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(review, businessContext, [], demoOptions);

    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
  });

  it('demo mode skips cost guard calls', async () => {
        openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const tracker = await import('@/lib/costs/tracker');
    const { generateResponse } = await import('../generator');
    await generateResponse(review, businessContext, [], demoOptions);

    expect(tracker.reserveCost).not.toHaveBeenCalled();
    expect(tracker.acquireConcurrencySlot).not.toHaveBeenCalled();
    expect(tracker.finalizeCost).not.toHaveBeenCalled();
    expect(tracker.recordApiCost).not.toHaveBeenCalled();
  });

  it('production mode runs full cost guard lifecycle', async () => {
        openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const tracker = await import('@/lib/costs/tracker');
    const { generateResponse } = await import('../generator');
    await generateResponse(review, businessContext, [], productionOptions);

    expect(tracker.reserveCost).toHaveBeenCalledWith('biz-001', 'standard');
    expect(tracker.acquireConcurrencySlot).toHaveBeenCalledWith('biz-001');
    expect(tracker.finalizeCost).toHaveBeenCalled();
    expect(tracker.setCachedGeneration).toHaveBeenCalled();
    expect(tracker.recordApiCost).toHaveBeenCalled();
    expect(tracker.releaseConcurrencySlot).toHaveBeenCalledWith('biz-001');
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
    const result = await generateResponse(review, businessContext, [], productionOptions);

    expect(result.responseText).toBe('Cached response');
    expect(result.costUsd).toBe(0);
    expect(tracker.reserveCost).not.toHaveBeenCalled();
  });

  it('throws TypeError when production mode missing reviewId', async () => {
    const { generateResponse } = await import('../generator');
    const opts: GenerationOptions = { mode: 'production', version: 1, businessId: 'b', subscriptionTier: 'standard' };

    await expect(
      generateResponse(review, businessContext, [], opts),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError when production mode missing businessId', async () => {
    const { generateResponse } = await import('../generator');
    const opts: GenerationOptions = { mode: 'production', reviewId: 'r', version: 1, subscriptionTier: 'standard' };

    await expect(
      generateResponse(review, businessContext, [], opts),
    ).rejects.toThrow(TypeError);
  });

  it('releases concurrency slot and cost on LLM failure in production', async () => {
            openaiCreate.mockRejectedValueOnce(new Error('fail'));
    anthropicCreate.mockRejectedValueOnce(new Error('also fail'));

    const tracker = await import('@/lib/costs/tracker');
    const { generateResponse } = await import('../generator');

    await expect(
      generateResponse(review, businessContext, [], productionOptions),
    ).rejects.toThrow();

    expect(tracker.releaseConcurrencySlot).toHaveBeenCalledWith('biz-001');
    expect(tracker.releaseCost).toHaveBeenCalledWith('biz-001', '2025-06-15');
  });

  it('throws TypeError when production mode receives demo-shaped context', async () => {
    const { generateResponse } = await import('../generator');
    const demoCtx = { name: 'Test', category: 'restaurant' };

    await expect(
      generateResponse(review, demoCtx, [], productionOptions),
    ).rejects.toThrow(TypeError);
  });

  it('still returns result when post-finalization cache write fails', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Thanks!'));

    const tracker = await import('@/lib/costs/tracker');
    vi.mocked(tracker.setCachedGeneration).mockRejectedValueOnce(
      new Error('Redis timeout'),
    );

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(review, businessContext, [], productionOptions);

    expect(result.responseText).toBe('Thanks!');
    expect(tracker.finalizeCost).toHaveBeenCalled();
  });

  it('releases cost reservation when concurrency slot acquisition fails', async () => {
    const tracker = await import('@/lib/costs/tracker');
    vi.mocked(tracker.acquireConcurrencySlot).mockRejectedValueOnce(
      new Error('Concurrency limit exceeded'),
    );

    const { generateResponse } = await import('../generator');
    await expect(
      generateResponse(review, businessContext, [], productionOptions),
    ).rejects.toThrow('Concurrency limit exceeded');

    expect(tracker.releaseCost).toHaveBeenCalledWith('biz-001', '2025-06-15');
    expect(tracker.releaseConcurrencySlot).not.toHaveBeenCalled();
  });

  it('returns result even when finally-block cleanup throws', async () => {
    openaiCreate.mockResolvedValueOnce(openAIResponse('Good response'));

    const tracker = await import('@/lib/costs/tracker');
    vi.mocked(tracker.releaseConcurrencySlot).mockRejectedValueOnce(
      new Error('Redis connection lost'),
    );

    const { generateResponse } = await import('../generator');
    const result = await generateResponse(review, businessContext, [], productionOptions);

    expect(result.responseText).toBe('Good response');
  });
});
