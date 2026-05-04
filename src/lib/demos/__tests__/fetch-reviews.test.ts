import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `fetch-reviews.ts` captures `MOCK_EXTERNAL_APIS` at module-load time
// (mirroring `generator.ts`). To toggle the flag per-test we must
// `vi.resetModules()` and dynamically import after mutating the env.

describe('fetchSerpApiReviews', () => {
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

  it('returns mock reviews when MOCK_EXTERNAL_APIS is true', async () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    const { fetchSerpApiReviews } = await import('../fetch-reviews');

    const reviews = await fetchSerpApiReviews(
      'ChIJN1t_tDeuEmsRUsoyG83frY4',
    );

    expect(reviews.length).toBeGreaterThanOrEqual(1);
    expect(reviews[0]).toHaveProperty('reviewerName');
    expect(reviews[0]).toHaveProperty('starRating');
  });

  it('caps results at 15 reviews', async () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    const { fetchSerpApiReviews } = await import('../fetch-reviews');

    const reviews = await fetchSerpApiReviews(
      'ChIJN1t_tDeuEmsRUsoyG83frY4',
    );

    expect(reviews.length).toBeLessThanOrEqual(15);
  });
});
