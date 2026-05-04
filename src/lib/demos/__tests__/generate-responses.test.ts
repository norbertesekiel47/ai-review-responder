import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `generate-responses.ts` captures `MOCK_EXTERNAL_APIS` at module-load time
// (mirroring `generator.ts`). To toggle the flag per-test we must
// `vi.resetModules()` and dynamically import after mutating the env.

describe('generateResponsesForReviews', () => {
  let originalMockExternalApis: string | undefined;

  beforeEach(() => {
    originalMockExternalApis = process.env.MOCK_EXTERNAL_APIS;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalMockExternalApis === undefined) {
      delete process.env.MOCK_EXTERNAL_APIS;
    } else {
      process.env.MOCK_EXTERNAL_APIS = originalMockExternalApis;
    }
    vi.resetModules();
  });

  it('returns responses for all reviews in mock mode', async () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    const { generateResponsesForReviews } = await import(
      '../generate-responses'
    );

    const result = await generateResponsesForReviews(
      [
        {
          reviewerName: 'A',
          starRating: 5,
          reviewText: 'Great',
          reviewDate: '2026-01-01',
          detectedLanguage: 'en',
        } as never,
        {
          reviewerName: 'B',
          starRating: 4,
          reviewText: 'Good',
          reviewDate: '2026-01-02',
          detectedLanguage: 'en',
        } as never,
      ],
      { name: 'Test Biz', category: 'restaurant' },
    );

    expect(result.reviews).toHaveLength(2);
    expect(result.responses).toHaveLength(2);
    expect(result.metadata.totalReviews).toBe(2);
    expect(result.metadata.generationDurationMs).toBeGreaterThanOrEqual(0);
  });
});
