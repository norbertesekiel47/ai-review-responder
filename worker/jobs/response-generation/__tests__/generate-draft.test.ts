import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { GenerationResult, BusinessContext } from '../../../../src/lib/responses/types';
import type { NormalizedReview } from '../../../../src/lib/reviews/types';
import type { WorkerLogger } from '../../../../src/lib/shared/logger';
import { asLocationId } from '../../../../src/lib/shared/ids';

// ── Hoisted mocks (TransientLLMError must be shared by the error-classifier
//    mock factory + tests so `instanceof` matches across module boundaries) ──
const {
  mockGenerateResponse,
  mockGenerateMockResponse,
  mockGetApprovedResponsePairs,
  mockCheckRegenBudget,
  mockSetCachedGeneration,
  mockIsMockMode,
  mockCaptureMessage,
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
    mockCaptureMessage: vi.fn(),
    TransientLLMError,
  };
});

vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('../../../../src/lib/responses/generator', () => ({
  generateResponse: mockGenerateResponse,
}));
// generate-draft.ts now imports TransientLLMError from the LLM seam's
// error-classifier (not the retired generator re-export). Swap only that class
// for the hoisted one so the test and the module under test share its identity;
// keep the real isTransientLLMError/redactProviderError.
vi.mock('../../../../src/lib/llm/error-classifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/llm/error-classifier')>();
  return { ...actual, TransientLLMError };
});
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
  RegenBudgetExceededError: class extends Error {
    name = 'RegenBudgetExceededError';
    constructor(public readonly reviewId: string) { super(`Regeneration budget exceeded for review ${reviewId}`); }
  },
}));

vi.mock('../../../../src/lib/costs/concurrency-guard', () => ({
  ConcurrencyLimitExceededError: class extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) { super(`Concurrency limit exceeded for business ${businessId}`); }
  },
}));

// Import after mocks are wired
import { generateDraft } from '../generate-draft';
import type { GenerationContext } from '../load-context';
import {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  RegenBudgetExceededError,
} from '../../../../src/lib/costs/tracker';
import { ConcurrencyLimitExceededError } from '../../../../src/lib/costs/concurrency-guard';
// Real (unmocked) error module so `instanceof` resolves against the same class
// generate-draft imports — the dedicated errors.ts is intentionally not mocked.
import { CostInfraUnavailableError } from '../../../../src/lib/costs/errors';

const BIZ_CONTEXT: BusinessContext = {
  id: 'biz-1', name: 'Test Biz', category: 'restaurant', tone: 'warm',
  productsServices: null, staffNames: [], highlightFacts: [], avoidFacts: [],
  sampleResponses: [], subscriptionTier: 'copilot',
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
  return {
    accountId: 'acct-1',
    subscriptionTier: 'autopilot',
    loadedReviewContentHash: 'hash-1',
    normalizedReview: REVIEW,
    businessContext: { ...BIZ_CONTEXT, ...overrides },
  };
}

const IDS = { reviewId: 'rev-1', version: 1, businessId: asLocationId('biz-1'), triageSeverity: null };

// generateDraft now takes the injected client as its leading arg; here it is
// only forwarded to the mocked getApprovedResponsePairs / generateResponse, so
// a bare stub suffices (no real query is issued through it).
const mockSql = {} as unknown as Sql;

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
    const outcome = await generateDraft(mockSql, ctx(), IDS, makeLogger());
    expect(outcome).toEqual({ kind: 'ok', result: MOCK_RESULT, retryCostId: undefined });
    // version === 1 must skip the regen-budget check entirely.
    expect(mockCheckRegenBudget).not.toHaveBeenCalled();
  });

  it('classifies CostLimitExceededError as failed (no throw)', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new CostLimitExceededError('biz-1'));
    const outcome = await generateDraft(mockSql, ctx(), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('cost limit exceeded');
  });

  it('emits a Sentry alert when a cost cap is exhausted (dropped paid work must not be silent)', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new GlobalCostLimitExceededError());
    await generateDraft(mockSql, ctx(), IDS, makeLogger());
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const callArgs = mockCaptureMessage.mock.calls[0] as unknown[];
    const opts = callArgs[1] as { level?: string; tags?: Record<string, string> };
    expect(opts.tags?.cost_event).toBe('limit_exceeded');
    expect(opts.tags?.business_id).toBe('biz-1');
  });

  it('does NOT emit a cost alert on a clean generation', async () => {
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);
    await generateDraft(mockSql, ctx(), IDS, makeLogger());
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('emits a cost alert when a cost cap is hit during the avoid-facts guardrail retry', async () => {
    // First draft violates avoid_facts → triggers the guardrail retry; the retry
    // then exhausts the global cost cap. That must still alert + fail (not be
    // silently wrapped as guardrail_failed).
    const violating: GenerationResult = { ...MOCK_RESULT, responseText: 'has bad word', apiCostId: 'cost-1' };
    mockGenerateResponse
      .mockResolvedValueOnce(violating)
      .mockRejectedValueOnce(new GlobalCostLimitExceededError());

    const outcome = await generateDraft(mockSql, ctx({ avoidFacts: ['bad word'] }), IDS, makeLogger());

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('Global');
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const opts = mockCaptureMessage.mock.calls[0]?.[1] as { tags?: Record<string, string> };
    expect(opts.tags?.cost_event).toBe('limit_exceeded');
  });

  it('classifies GlobalCostLimitExceededError as failed', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new GlobalCostLimitExceededError());
    const outcome = await generateDraft(mockSql, ctx(), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
    // Distinct from the per-business cost path — carries the global message.
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('Global');
  });

  it('re-throws ConcurrencyLimitExceededError for BullMQ retry', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new ConcurrencyLimitExceededError('biz-1'));
    await expect(generateDraft(mockSql, ctx(), IDS, makeLogger())).rejects.toBeInstanceOf(ConcurrencyLimitExceededError);
  });

  it('re-throws TransientLLMError for BullMQ retry', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new TransientLLMError('rate limited'));
    await expect(generateDraft(mockSql, ctx(), IDS, makeLogger())).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('re-throws CostInfraUnavailableError for BullMQ retry (pre-LLM Redis infra blip, NOT terminal)', async () => {
    // A reserveCost/checkIdempotentCache/acquireConcurrencySlot transport failure
    // surfaces out of generateResponse as CostInfraUnavailableError — it must be
    // re-thrown (retry), not classified { kind: 'failed' } like a budget decision.
    mockGenerateResponse.mockRejectedValueOnce(new CostInfraUnavailableError('reserveCost'));
    await expect(generateDraft(mockSql, ctx(), IDS, makeLogger())).rejects.toBeInstanceOf(CostInfraUnavailableError);
  });

  it('classifies a permanent generation error as failed with generation_failed reason', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new Error('bad request'));
    const outcome = await generateDraft(mockSql, ctx(), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('generation_failed');
  });

  it('classifies RegenBudgetExceededError (version > 1) as failed without calling the LLM', async () => {
    mockCheckRegenBudget.mockRejectedValueOnce(new RegenBudgetExceededError('rev-1'));
    const outcome = await generateDraft(mockSql, ctx(), { ...IDS, version: 2 }, makeLogger());
    expect(outcome.kind).toBe('failed');
    expect(mockGenerateResponse).not.toHaveBeenCalled();
  });

  it('retries once on avoid-facts violation and returns the clean retry with retryCostId', async () => {
    const violating: GenerationResult = { ...MOCK_RESULT, responseText: 'This mentions bad word in it', apiCostId: 'cost-1' };
    const clean: GenerationResult = { ...MOCK_RESULT, responseText: 'Thank you so much!', apiCostId: 'cost-2', costUsd: 0.002 };
    mockGenerateResponse.mockResolvedValueOnce(violating).mockResolvedValueOnce(clean);

    const outcome = await generateDraft(mockSql, ctx({ avoidFacts: ['bad word'] }), IDS, makeLogger());

    expect(mockGenerateResponse).toHaveBeenCalledTimes(2);
    const calls = mockGenerateResponse.mock.calls as unknown[][];
    // options is arg[4] now that `sql` leads the generateResponse signature.
    const retryOpts = calls[1]?.[4] as Record<string, unknown> | undefined;
    expect(retryOpts).toMatchObject({ skipCache: true });
    expect(mockSetCachedGeneration).toHaveBeenCalledWith('rev-1', 1, expect.stringContaining('Thank you so much!'));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.retryCostId).toBe('cost-2');
      expect(outcome.result.responseText).toBe('Thank you so much!');
      expect(outcome.result.apiCostId).toBe('cost-1'); // original cost id retained on merged
    }
  });

  it('threads triageSeverity into generation options', async () => {
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);
    await generateDraft(mockSql, ctx(), { ...IDS, triageSeverity: 'high' }, makeLogger());
    expect(mockGenerateResponse).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({ triageSeverity: 'high' }),
    );
  });

  it('threads triageSeverity into the avoid-facts guardrail retry options too', async () => {
    const violating: GenerationResult = { ...MOCK_RESULT, responseText: 'has bad word', apiCostId: 'cost-1' };
    const clean: GenerationResult = { ...MOCK_RESULT, responseText: 'All good!', apiCostId: 'cost-2' };
    mockGenerateResponse.mockResolvedValueOnce(violating).mockResolvedValueOnce(clean);

    const outcome = await generateDraft(
      mockSql, ctx({ avoidFacts: ['bad word'] }), { ...IDS, triageSeverity: 'medium' }, makeLogger(),
    );

    expect(outcome.kind).toBe('ok');
    expect(mockGenerateResponse).toHaveBeenCalledTimes(2);
    const calls = mockGenerateResponse.mock.calls as unknown[][];
    // options is arg[4]; the retry must carry the same severity as the primary call.
    expect(calls[0]?.[4]).toMatchObject({ triageSeverity: 'medium' });
    expect(calls[1]?.[4]).toMatchObject({ triageSeverity: 'medium', skipCache: true });
  });

  describe('guardrail regen transient errors', () => {
    it.each([
      ['TransientLLMError', () => new TransientLLMError('openai 503')],
      ['CostInfraUnavailableError', () => new CostInfraUnavailableError('reserveCost')],
      ['ConcurrencyLimitExceededError', () => new ConcurrencyLimitExceededError('biz-1')],
    ])('re-throws %s from the regen call so BullMQ retries', async (_name, make) => {
      // First generateResponse call: violating draft. Second (regen): transient throw.
      const violating: GenerationResult = { ...MOCK_RESULT, responseText: 'has bad word', apiCostId: 'cost-1' };
      mockGenerateResponse
        .mockResolvedValueOnce(violating)
        .mockRejectedValueOnce(make());
      await expect(
        generateDraft(mockSql, ctx({ avoidFacts: ['bad word'] }), IDS, makeLogger()),
      ).rejects.toBeInstanceOf(make().constructor);
    });
  });

  it('fails when the avoid-facts violation persists after retry', async () => {
    const violating: GenerationResult = { ...MOCK_RESULT, responseText: 'has bad word', apiCostId: 'cost-1' };
    const stillViolating: GenerationResult = { ...MOCK_RESULT, responseText: 'still bad word here', apiCostId: 'cost-2' };
    mockGenerateResponse.mockResolvedValueOnce(violating).mockResolvedValueOnce(stillViolating);

    const outcome = await generateDraft(mockSql, ctx({ avoidFacts: ['bad word'] }), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('guardrail_failed');
  });
});
