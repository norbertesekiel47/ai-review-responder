import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    const result = await generateReviewSummary(makeReviews(5), 'biz-001');

    expect(result).not.toBeNull();
    expect(result!.summaryText).toBe(summaryText);
    expect(result!.provider).toBe('openai');
    expect(result!.costUsd).toBe(0.000_05);
    expect(openaiCreate).toHaveBeenCalledOnce();
  });

  it('returns null for empty reviews', async () => {
    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary([], 'biz-001');

    expect(result).toBeNull();
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('truncates to max 30 reviews', async () => {
    const summaryText = 'Summary of 30 reviews.';
    openaiCreate.mockResolvedValueOnce(openAIResponse(summaryText));

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(makeReviews(50), 'biz-001');

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
    const result = await generateReviewSummary(makeReviews(3), 'biz-001');

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
    const result = await generateReviewSummary(makeReviews(3), 'biz-001');

    expect(result).not.toBeNull();
    expect(result!.summaryText).toBe(summaryText);
    expect(result!.provider).toBe('anthropic');
  });

  it('returns null when both providers fail', async () => {
    openaiCreate.mockRejectedValueOnce(new Error('OpenAI down'));
    anthropicCreate.mockRejectedValueOnce(new Error('Anthropic down'));

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(makeReviews(3), 'biz-001');

    expect(result).toBeNull();
  });

  it('succeeds even if cost audit write fails', async () => {
    const { recordApiCost } = await import('@/lib/costs/audit');
    vi.mocked(recordApiCost).mockRejectedValueOnce(new Error('DB connection lost'));

    const summaryText = 'Summary despite audit failure.';
    openaiCreate.mockResolvedValueOnce(openAIResponse(summaryText));

    const generateReviewSummary = await getSut();
    const result = await generateReviewSummary(makeReviews(3), 'biz-001');

    expect(result).not.toBeNull();
    expect(result!.summaryText).toBe(summaryText);
  });
});
