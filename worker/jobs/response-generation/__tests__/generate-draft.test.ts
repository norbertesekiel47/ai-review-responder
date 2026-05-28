import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenerationResult, BusinessContext } from '../../../../src/lib/responses/types';
import type { NormalizedReview } from '../../../../src/lib/reviews/types';
import type { WorkerLogger } from '../../../../src/lib/shared/logger';
import { asLocationId } from '../../../../src/lib/shared/ids';

// ── Hoisted mocks (TransientLLMError must be shared by the factory + tests) ──
const {
  mockGenerateResponse,
  mockGenerateMockResponse,
  mockGetApprovedResponsePairs,
  mockCheckRegenBudget,
  mockSetCachedGeneration,
  mockIsMockMode,
  TransientLLMError,
} = vi.hoisted(() => {
  class TransientLLMError extends Error {
    name = 'TransientLLMError';
  }
  return {
    mockGenerateResponse: vi.fn<() => Promise<GenerationResult>>(),
    mockGenerateMockResponse: vi.fn<() => Promise<GenerationResult>>(),
    mockGetApprovedResponsePairs: vi.fn(async () => []),
    mockCheckRegenBudget: vi.fn(),
    mockSetCachedGeneration: vi.fn(),
    mockIsMockMode: vi.fn(() => false),
    TransientLLMError,
  };
});

vi.mock('../../../../src/lib/responses/generator', () => ({
  generateResponse: mockGenerateResponse,
  TransientLLMError,
}));
vi.mock('../../../../src/lib/responses/mock-generator', () => ({
  generateMockResponse: mockGenerateMockResponse,
}));
vi.mock('../../../../src/lib/responses/voice-learning', () => ({
  getApprovedResponsePairs: mockGetApprovedResponsePairs,
}));
vi.mock('../../../../src/lib/shared/mock-mode', () => ({
  isMockMode: mockIsMockMode,
}));
vi.mock('../../../../src/lib/costs/tracker', () => ({
  checkRegenBudget: mockCheckRegenBudget,
  setCachedGeneration: mockSetCachedGeneration,
  CostLimitExceededError: class CostLimitExceededError extends Error {
    name = 'CostLimitExceededError';
    constructor(public readonly businessId: string) { super(`Daily cost limit exceeded for business ${businessId}`); }
  },
  GlobalCostLimitExceededError: class extends Error {
    name = 'GlobalCostLimitExceededError';
    constructor() { super('Global daily cost limit exceeded'); }
  },
  ConcurrencyLimitExceededError: class extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) { super(`Concurrency limit exceeded for business ${businessId}`); }
  },
  RegenBudgetExceededError: class extends Error {
    name = 'RegenBudgetExceededError';
    constructor(public readonly reviewId: string) { super(`Regeneration budget exceeded for review ${reviewId}`); }
  },
}));

// Import after mocks are wired
import { generateDraft } from '../generate-draft';
import type { GenerationContext } from '../load-context';
import {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
} from '../../../../src/lib/costs/tracker';

const BIZ_CONTEXT: BusinessContext = {
  id: 'biz-1', name: 'Test Biz', category: 'restaurant', tone: 'warm',
  productsServices: null, staffNames: [], highlightFacts: [], avoidFacts: [],
  sampleResponses: [], subscriptionTier: 'standard',
};

const REVIEW: NormalizedReview = {
  reviewerName: 'Jane', starRating: 5, reviewText: 'Great!',
  reviewDate: '2026-04-01', detectedLanguage: 'en',
};

const MOCK_RESULT: GenerationResult = {
  responseText: 'Thank you, Jane!', language: 'en', provider: 'openai', model: 'gpt-4o-mini',
  usage: { promptTokens: 100, completionTokens: 50 }, costUsd: 0.001, apiCostId: 'cost-1',
};

function ctx(overrides: Partial<BusinessContext> = {}): GenerationContext {
  return { accountId: 'acct-1', normalizedReview: REVIEW, businessContext: { ...BIZ_CONTEXT, ...overrides } };
}

const IDS = { reviewId: 'rev-1', version: 1, businessId: asLocationId('biz-1') };

function makeLogger(): WorkerLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as WorkerLogger;
}

describe('generateDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMockMode.mockReturnValue(false);
    mockGetApprovedResponsePairs.mockResolvedValue([]);
  });

  it('returns ok with the result on a clean generation', async () => {
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);
    const outcome = await generateDraft(ctx(), IDS, makeLogger());
    expect(outcome).toEqual({ kind: 'ok', result: MOCK_RESULT, retryCostId: undefined });
    // version === 1 must skip the regen-budget check entirely.
    expect(mockCheckRegenBudget).not.toHaveBeenCalled();
  });

  it('classifies CostLimitExceededError as failed (no throw)', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new CostLimitExceededError('biz-1'));
    const outcome = await generateDraft(ctx(), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('cost limit exceeded');
  });

  it('classifies GlobalCostLimitExceededError as failed', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new GlobalCostLimitExceededError());
    const outcome = await generateDraft(ctx(), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
    // Distinct from the per-business cost path — carries the global message.
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('Global');
  });

  it('re-throws ConcurrencyLimitExceededError for BullMQ retry', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new ConcurrencyLimitExceededError('biz-1'));
    await expect(generateDraft(ctx(), IDS, makeLogger())).rejects.toBeInstanceOf(ConcurrencyLimitExceededError);
  });

  it('re-throws TransientLLMError for BullMQ retry', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new TransientLLMError('rate limited'));
    await expect(generateDraft(ctx(), IDS, makeLogger())).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('classifies a permanent generation error as failed with generation_failed reason', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new Error('bad request'));
    const outcome = await generateDraft(ctx(), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('generation_failed');
  });

  it('classifies RegenBudgetExceededError (version > 1) as failed without calling the LLM', async () => {
    mockCheckRegenBudget.mockRejectedValueOnce(new RegenBudgetExceededError('rev-1'));
    const outcome = await generateDraft(ctx(), { ...IDS, version: 2 }, makeLogger());
    expect(outcome.kind).toBe('failed');
    expect(mockGenerateResponse).not.toHaveBeenCalled();
  });

  it('retries once on avoid-facts violation and returns the clean retry with retryCostId', async () => {
    const violating: GenerationResult = { ...MOCK_RESULT, responseText: 'This mentions bad word in it', apiCostId: 'cost-1' };
    const clean: GenerationResult = { ...MOCK_RESULT, responseText: 'Thank you so much!', apiCostId: 'cost-2', costUsd: 0.002 };
    mockGenerateResponse.mockResolvedValueOnce(violating).mockResolvedValueOnce(clean);

    const outcome = await generateDraft(ctx({ avoidFacts: ['bad word'] }), IDS, makeLogger());

    expect(mockGenerateResponse).toHaveBeenCalledTimes(2);
    const calls = mockGenerateResponse.mock.calls as unknown[][];
    const retryOpts = calls[1]?.[3] as Record<string, unknown> | undefined;
    expect(retryOpts).toMatchObject({ skipCache: true });
    expect(mockSetCachedGeneration).toHaveBeenCalledWith('rev-1', 1, expect.stringContaining('Thank you so much!'));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.retryCostId).toBe('cost-2');
      expect(outcome.result.responseText).toBe('Thank you so much!');
      expect(outcome.result.apiCostId).toBe('cost-1'); // original cost id retained on merged
    }
  });

  it('fails when the avoid-facts violation persists after retry', async () => {
    const violating: GenerationResult = { ...MOCK_RESULT, responseText: 'has bad word', apiCostId: 'cost-1' };
    const stillViolating: GenerationResult = { ...MOCK_RESULT, responseText: 'still bad word here', apiCostId: 'cost-2' };
    mockGenerateResponse.mockResolvedValueOnce(violating).mockResolvedValueOnce(stillViolating);

    const outcome = await generateDraft(ctx({ avoidFacts: ['bad word'] }), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('guardrail_failed');
  });
});
