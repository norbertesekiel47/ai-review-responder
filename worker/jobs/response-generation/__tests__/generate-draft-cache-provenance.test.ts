// End-to-end worker-level cache-provenance coverage (ADR 0017; codex round-1
// CRITICAL for #728): drives generateDraft with the REAL generateResponse
// production path — real cache accept/write logic, real cost-guard — with the
// Redis cache store mocked as an in-memory Map and the LLM SDKs mocked. This
// proves ctx.loadedReviewContentHash threads all the way from the worker
// context into the cache identity; the generator-level unit tests alone cannot
// catch a missing thread in generate-draft.ts. Separate file from
// generate-draft.test.ts because that harness mocks generateResponse at module
// scope, which would bypass the very cache path under test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { BusinessContext } from '../../../../src/lib/responses/types';
import type { NormalizedReview } from '../../../../src/lib/reviews/types';
import type { WorkerLogger } from '../../../../src/lib/shared/logger';
import { asLocationId } from '../../../../src/lib/shared/ids';
import { llmCircuitBreaker } from '../../../../src/lib/llm/circuit-breaker';

// ── Hoisted mocks ────────────────────────────────────────────────────

const { openaiCreate, anthropicCreate, cacheStore } = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  anthropicCreate: vi.fn(),
  cacheStore: new Map<string, string>(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: openaiCreate } };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: anthropicCreate };
  },
}));

vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('../../../../src/lib/reviews/detect-language', () => ({
  detectResponseLanguage: vi.fn().mockReturnValue('en'),
}));

// Map-backed cache store: the payload round-trips through the real
// tryWriteCache / cache-accept code in generator.ts, only Redis is faked.
vi.mock('../../../../src/lib/costs/tracker', () => ({
  checkIdempotentCache: vi.fn(async (reviewId: string, version: number) =>
    cacheStore.get(`${reviewId}:${version}`) ?? null),
  setCachedGeneration: vi.fn(async (reviewId: string, version: number, data: string) => {
    cacheStore.set(`${reviewId}:${version}`, data);
  }),
  clearCachedGeneration: vi.fn(async (reviewId: string, version: number) => {
    cacheStore.delete(`${reviewId}:${version}`);
  }),
  reserveCost: vi.fn().mockResolvedValue('2026-08-09'),
  finalizeCost: vi.fn().mockResolvedValue(undefined),
  releaseCost: vi.fn().mockResolvedValue(undefined),
  checkRegenBudget: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../../../../src/lib/costs/concurrency-guard', () => ({
  acquireConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  releaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  ConcurrencyLimitExceededError: class ConcurrencyLimitExceededError extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) {
      super(`Concurrency limit exceeded for business ${businessId}`);
    }
  },
}));

vi.mock('../../../../src/lib/costs/audit', () => ({
  recordApiCost: vi.fn().mockResolvedValue('cost-uuid-001'),
  calculateCostUsd: vi.fn().mockReturnValue(0.000_123),
}));

vi.mock('../../../../src/lib/responses/voice-learning', () => ({
  getApprovedResponsePairs: vi.fn(async () => []),
}));

vi.mock('../../../../src/lib/shared/mock-mode', () => ({
  isMockMode: vi.fn(() => false),
}));

// Import after mocks are wired
import { generateDraft } from '../generate-draft';
import type { GenerationContext } from '../load-context';

// ── Fixtures ─────────────────────────────────────────────────────────

const BIZ_CONTEXT: BusinessContext = {
  id: 'biz-1', name: 'Test Biz', category: 'restaurant', tone: 'warm',
  productsServices: null, staffNames: [], highlightFacts: [], avoidFacts: [],
  sampleResponses: [], subscriptionTier: 'copilot',
};

const REVIEW: NormalizedReview = {
  reviewerName: 'Jane', starRating: 5, reviewText: 'Great!',
  reviewDate: '2026-04-01', detectedLanguage: 'en',
};

function ctx(loadedReviewContentHash: string | null): GenerationContext {
  return {
    accountId: 'acct-1',
    subscriptionTier: 'autopilot',
    loadedReviewContentHash,
    normalizedReview: REVIEW,
    businessContext: BIZ_CONTEXT,
  };
}

const IDS = { reviewId: 'rev-1', version: 1, businessId: asLocationId('biz-1'), triageSeverity: null };

const mockSql = {} as unknown as Sql;

function makeLogger(): WorkerLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as WorkerLogger;
}

function openAIResponse(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('generateDraft cache provenance (same-version replacement)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
    // Real runLlmTask + live breaker singleton — reset so transient rejections
    // never accumulate across tests (mirrors generator.test.ts).
    llmCircuitBreaker.reset();
  });

  it('replacement job at the same version regenerates against current content instead of serving the stale cached draft', async () => {
    // Attempt A — the original job loads content hash H1, generates, caches.
    openaiCreate.mockResolvedValueOnce(openAIResponse('draft-H1'));
    const a = await generateDraft(mockSql, ctx('hash-H1'), IDS, makeLogger());
    expect(a.kind).toBe('ok');
    if (a.kind === 'ok') expect(a.result.responseText).toBe('draft-H1');
    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(cacheStore.size).toBe(1);
    const cachedA = JSON.parse(cacheStore.get('rev-1:1') ?? '{}') as { reviewContentHash?: string | null };
    expect(cachedA.reviewContentHash).toBe('hash-H1');

    // Attempt B — live-ingest's content-change REPLACEMENT job: same reviewId,
    // deliberately the SAME version, but it loaded hash H2. It must NOT be
    // served the stale H1 draft; the LLM must run again on current content.
    openaiCreate.mockResolvedValueOnce(openAIResponse('draft-H2'));
    const b = await generateDraft(mockSql, ctx('hash-H2'), IDS, makeLogger());
    expect(b.kind).toBe('ok');
    if (b.kind === 'ok') {
      expect(b.result.responseText).toBe('draft-H2');
      expect(b.result.responseText).not.toBe('draft-H1');
    }
    expect(openaiCreate).toHaveBeenCalledTimes(2);

    // The fresh draft is re-cached under H2 provenance…
    const cachedB = JSON.parse(cacheStore.get('rev-1:1') ?? '{}') as { reviewContentHash?: string | null; responseText?: string };
    expect(cachedB).toMatchObject({ responseText: 'draft-H2', reviewContentHash: 'hash-H2' });

    // …and a retry of the replacement (same H2) IS served from cache — the
    // rejection above was provenance-driven, not a broken cache path.
    const c = await generateDraft(mockSql, ctx('hash-H2'), IDS, makeLogger());
    expect(c.kind).toBe('ok');
    if (c.kind === 'ok') expect(c.result.responseText).toBe('draft-H2');
    expect(openaiCreate).toHaveBeenCalledTimes(2);
  });
});
