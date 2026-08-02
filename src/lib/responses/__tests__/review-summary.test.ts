import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { llmCircuitBreaker } from '@/lib/llm/circuit-breaker';

// generateReviewSummary now takes an injected `sql` as its leading arg; it is
// only forwarded to the mocked recordApiCost here, so a bare stub suffices.
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

vi.mock('@/lib/costs/audit', () => ({
  recordApiCost: vi.fn().mockResolvedValue('cost-uuid-001'),
  calculateCostUsd: vi.fn().mockReturnValue(0.000_05),
}));

const mockReserveCost = vi.fn().mockResolvedValue('2026-04-14');
const mockFinalizeCost = vi.fn().mockResolvedValue(undefined);
const mockReleaseCost = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/costs/tracker', () => ({
  reserveCost: (...args: unknown[]) => mockReserveCost(...args),
  finalizeCost: (...args: unknown[]) => mockFinalizeCost(...args),
  releaseCost: (...args: unknown[]) => mockReleaseCost(...args),
  CostLimitExceededError: class CostLimitExceededError extends Error {
    constructor(public readonly businessId: string) {
      super(`Daily cost limit exceeded for business ${businessId}`);
      this.name = 'CostLimitExceededError';
    }
  },
  GlobalCostLimitExceededError: class GlobalCostLimitExceededError extends Error {
    constructor() {
      super('Global daily cost limit exceeded');
      this.name = 'GlobalCostLimitExceededError';
    }
  },
}));

vi.mock('@/lib/costs/concurrency-guard', () => ({
  acquireConcurrencySlot: vi.fn().mockResolvedValue(undefined),
  releaseConcurrencySlot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/costs/cost-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/costs/cost-guard')>('@/lib/costs/cost-guard');
  return actual;
});

let mockModeEnabled = false;
vi.mock('@/lib/shared/mock-mode', () => ({
  isMockMode: () => mockModeEnabled,
}));

// ── Helpers ──────────────────────────────────────────────────────────

import type { ReviewForSummary } from '../review-summary';

function openAIResponse(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 80, completion_tokens: 40 },
  };
}

function anthropicResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 80, output_tokens: 40 },
  };
}

function makeReviews(count: number): ReviewForSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    starRating: (i % 5) + 1,
    reviewText: `Review number ${i + 1} with some text content.`,
  }));
}

// ── Tests ────────────────────────────────────────────────────────────

describe('generateReviewSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModeEnabled = false;
    // This suite mocks the raw SDKs but drives the REAL runLlmTask + live
    // breaker singleton; without a reset, transient rejections accumulate
    // across tests and could trip the breaker mid-file (order-dependent).
    llmCircuitBreaker.reset();
  });

  // Lazy-import so mocks are wired up first
  async function getSut() {
    const mod = await import('../review-summary');
    return mod.generateReviewSummary;
  }

  it('returns LLM summary for non-empty reviews', async () => {
    const summaryText = 'Customers love the food but mention slow service on weekends.';
    openaiCreate.mockResolvedValueOnce(openAIResponse(summaryText));

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(mockSql, makeReviews(5), 'biz-001', 'copilot');

    expect(result).not.toBeNull();
    expect(result!.summaryText).toBe(summaryText);
    expect(result!.provider).toBe('openai');
    expect(result!.costUsd).toBe(0.000_05);
    expect(openaiCreate).toHaveBeenCalledOnce();
  });

  it('returns null for empty reviews', async () => {
    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(mockSql, [], 'biz-001', 'copilot');

    expect(result).toBeNull();
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('truncates to max 30 reviews', async () => {
    const summaryText = 'Summary of 30 reviews.';
    openaiCreate.mockResolvedValueOnce(openAIResponse(summaryText));

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(mockSql, makeReviews(50), 'biz-001', 'copilot');

    expect(result).not.toBeNull();
    // The user prompt should reference 30 reviews, not 50
    const callArgs = openaiCreate.mock.calls[0]![0];
    const userMessage = callArgs.messages[1].content as string;
    expect(userMessage).toContain('30 recent customer reviews');
    expect(userMessage).not.toContain('Review number 31');
  });

  it('returns mock summary in mock mode', async () => {
    mockModeEnabled = true;

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(mockSql, makeReviews(3), 'biz-001', 'copilot');

    expect(result).not.toBeNull();
    expect(result!.provider).toBe('mock');
    expect(result!.costUsd).toBe(0);
    expect(result!.summaryText).toContain('positive');
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it('falls back to Anthropic when OpenAI fails', async () => {
    const summaryText = 'Anthropic fallback summary.';
    openaiCreate.mockRejectedValueOnce(new Error('OpenAI rate limit'));
    anthropicCreate.mockResolvedValueOnce(anthropicResponse(summaryText));

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(mockSql, makeReviews(3), 'biz-001', 'copilot');

    expect(result).not.toBeNull();
    expect(result!.summaryText).toBe(summaryText);
    expect(result!.provider).toBe('anthropic');
  });

  it('returns null when both providers fail', async () => {
    openaiCreate.mockRejectedValueOnce(new Error('OpenAI down'));
    anthropicCreate.mockRejectedValueOnce(new Error('Anthropic down'));

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(mockSql, makeReviews(3), 'biz-001', 'copilot');

    expect(result).toBeNull();
  });

  it('succeeds even if cost audit write fails', async () => {
    const { recordApiCost } = await import('@/lib/costs/audit');
    vi.mocked(recordApiCost).mockRejectedValueOnce(new Error('DB connection lost'));

    const summaryText = 'Summary despite audit failure.';
    openaiCreate.mockResolvedValueOnce(openAIResponse(summaryText));

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(mockSql, makeReviews(3), 'biz-001', 'copilot');

    expect(result).not.toBeNull();
    expect(result!.summaryText).toBe(summaryText);
  });

  it('calls reserveCost before LLM and finalizeCost after', async () => {
    const summaryText = 'Cost-tracked summary.';
    openaiCreate.mockResolvedValueOnce(openAIResponse(summaryText));

    const generateReviewSummary = await getSut();
    await generateReviewSummary(mockSql, makeReviews(3), 'biz-001', 'copilot');

    // Default tier is 'copilot' when not specified; trailing undefined =
    // estimateCents omitted, the 15¢ default (#628).
    expect(mockReserveCost).toHaveBeenCalledWith('biz-001', 'copilot', undefined);
    expect(mockFinalizeCost).toHaveBeenCalledWith('biz-001', expect.any(Number), '2026-04-14', undefined);
    expect(mockReleaseCost).not.toHaveBeenCalled();
  });

  it('releases cost reservation when LLM call fails', async () => {
    openaiCreate.mockRejectedValueOnce(new Error('OpenAI down'));
    anthropicCreate.mockRejectedValueOnce(new Error('Anthropic down'));

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(mockSql, makeReviews(3), 'biz-001', 'copilot');

    expect(result).toBeNull();
    expect(mockReleaseCost).toHaveBeenCalledWith('biz-001', '2026-04-14', undefined);
    expect(mockFinalizeCost).not.toHaveBeenCalled();
  });

  it('returns null gracefully when cost limit exceeded', async () => {
    const { CostLimitExceededError } = await import('@/lib/costs/tracker');
    mockReserveCost.mockRejectedValueOnce(new CostLimitExceededError('biz-001'));

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(mockSql, makeReviews(3), 'biz-001', 'copilot');

    expect(result).toBeNull();
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it('finalizeCost error: returns summary, no releaseCost, recordApiCost still called', async () => {
    const summaryText = 'Summary despite finalize flake.';
    openaiCreate.mockResolvedValueOnce(openAIResponse(summaryText));

    // Mock finalizeCost to throw (the wrapper will catch it due to onFinalizeError: 'log-and-return-value')
    mockFinalizeCost.mockRejectedValueOnce(new Error('Redis timeout during finalize'));

    const { recordApiCost } = await import('@/lib/costs/audit');
    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(mockSql, makeReviews(3), 'biz-001', 'copilot');

    expect(result).not.toBeNull();
    expect(result!.summaryText).toBe(summaryText);
    expect(mockReleaseCost).not.toHaveBeenCalled();
    // recordApiCost is called AFTER the wrapper returns, so it still runs
    expect(recordApiCost).toHaveBeenCalled();
  });
});
