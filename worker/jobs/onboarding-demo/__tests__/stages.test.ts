import { beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseOnboardingDemoReservation } from '../reservation';
import { resolveOnboardingDemoPlaceId } from '../place-resolution';
import { buildOnboardingDemoSource } from '../demo-source';
import { failOnboardingDemoTerminal } from '../terminal';
import { resolvePlaceId } from '../../../../src/lib/reviews/place-id-resolver';
import { fetchSerpApiReviews } from '../../../../src/lib/demos/fetch-reviews';
import { selectQualifyingReviews } from '../../../../src/lib/demos/select-qualifying';
import { generateResponsesForReviews } from '../../../../src/lib/demos/generate-responses';
import { getFallbackDemo } from '../../../../src/lib/demos/fallback-content';
import { failDemo } from '../../../../src/lib/demos/lifecycle';
import type { GenerationResult } from '../../../../src/lib/responses/types';
import type { NormalizedReview } from '../../../../src/lib/reviews/types';

vi.mock('../../../../src/lib/reviews/place-id-resolver', () => ({
  resolvePlaceId: vi.fn(),
}));

vi.mock('../../../../src/lib/demos/fetch-reviews', () => ({
  fetchSerpApiReviews: vi.fn(),
}));

vi.mock('../../../../src/lib/demos/select-qualifying', () => ({
  selectQualifyingReviews: vi.fn(),
}));

vi.mock('../../../../src/lib/demos/generate-responses', () => ({
  generateResponsesForReviews: vi.fn(),
}));

vi.mock('../../../../src/lib/demos/fallback-content', () => ({
  getFallbackDemo: vi.fn(),
}));

vi.mock('../../../../src/lib/demos/lifecycle', () => ({
  failDemo: vi.fn(),
}));

const validPlaceId = 'ChIJ12345678901234567';

const review = (overrides: Partial<NormalizedReview> = {}): NormalizedReview => ({
  reviewerName: 'Nora',
  starRating: 5,
  reviewText: 'Great service',
  reviewDate: '2026-05-20',
  detectedLanguage: 'en',
  ...overrides,
});

const response = (overrides: Partial<GenerationResult> = {}): GenerationResult => ({
  responseText: 'Thank you!',
  language: 'en',
  provider: 'openai',
  model: 'gpt-4o-mini',
  usage: { promptTokens: 10, completionTokens: 5 },
  costUsd: 0.01,
  apiCostId: null,
  ...overrides,
});

describe('releaseOnboardingDemoReservation', () => {
  it('does not call finalize when reservation date is missing', async () => {
    const finalizeCost = vi.fn();

    await releaseOnboardingDemoReservation({
      reservationDate: undefined,
      logger: { error: vi.fn() },
      finalizeCost,
    });

    expect(finalizeCost).not.toHaveBeenCalled();
  });

  it('finalizes reservation date with zero actual cents', async () => {
    const finalizeCost = vi.fn().mockResolvedValue(undefined);

    await releaseOnboardingDemoReservation({
      reservationDate: '2026-05-20',
      logger: { error: vi.fn() },
      finalizeCost,
    });

    expect(finalizeCost).toHaveBeenCalledWith('2026-05-20', 0);
  });

  it('logs finalize failures and does not throw', async () => {
    const logger = { error: vi.fn() };

    await expect(
      releaseOnboardingDemoReservation({
        reservationDate: '2026-05-20',
        logger,
        finalizeCost: vi.fn().mockRejectedValue(new Error('redis unavailable')),
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to release cost reservation: redis unavailable',
    );
  });
});

describe('resolveOnboardingDemoPlaceId', () => {
  beforeEach(() => {
    vi.mocked(resolvePlaceId).mockReset();
  });

  it('returns a valid raw Place ID as-is', async () => {
    await expect(
      resolveOnboardingDemoPlaceId({
        googlePlaceId: validPlaceId,
        googleMapsUrl: undefined,
        mockMode: false,
      }),
    ).resolves.toBe(validPlaceId);

    expect(resolvePlaceId).not.toHaveBeenCalled();
  });

  it('uses the provided id in mock mode', async () => {
    await expect(
      resolveOnboardingDemoPlaceId({
        googlePlaceId: 'not-a-real-place-id',
        googleMapsUrl: undefined,
        mockMode: true,
      }),
    ).resolves.toBe('not-a-real-place-id');
  });

  it('uses mock-place-id in mock mode when id is empty', async () => {
    await expect(
      resolveOnboardingDemoPlaceId({
        googlePlaceId: '',
        googleMapsUrl: undefined,
        mockMode: true,
      }),
    ).resolves.toBe('mock-place-id');
  });

  it('resolves a Google Maps URL when raw id is invalid', async () => {
    vi.mocked(resolvePlaceId).mockResolvedValue('resolved-place-id');

    await expect(
      resolveOnboardingDemoPlaceId({
        googlePlaceId: 'cid-or-bad-id',
        googleMapsUrl: `https://www.google.com/maps/place/?q=place_id:${validPlaceId}`,
        mockMode: false,
      }),
    ).resolves.toBe('resolved-place-id');

    expect(resolvePlaceId).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: validPlaceId }),
    );
  });

  it('throws when raw id is invalid and no URL is available', async () => {
    await expect(
      resolveOnboardingDemoPlaceId({
        googlePlaceId: 'cid-or-bad-id',
        googleMapsUrl: undefined,
        mockMode: false,
      }),
    ).rejects.toThrow('Invalid Place ID and no URL available for resolution');
  });
});

describe('buildOnboardingDemoSource', () => {
  const fallbackReview = review({ reviewerName: 'Fallback' });
  const fallbackResponse = response({ responseText: 'Fallback response' });

  beforeEach(() => {
    vi.mocked(fetchSerpApiReviews).mockReset();
    vi.mocked(selectQualifyingReviews).mockReset();
    vi.mocked(generateResponsesForReviews).mockReset();
    vi.mocked(getFallbackDemo).mockReset();
    vi.mocked(getFallbackDemo).mockReturnValue({
      reviews: [fallbackReview],
      responses: [fallbackResponse],
    });
  });

  it('logs the existing warning and returns curated fallback when SerpAPI fails', async () => {
    const logger = { warn: vi.fn() };
    vi.mocked(fetchSerpApiReviews).mockRejectedValue(new Error('serp down'));

    const result = await buildOnboardingDemoSource({
      demoId: 'demo_123',
      googlePlaceId: validPlaceId,
      businessName: 'RepWorth Cafe',
      category: 'Cafe',
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'SerpAPI fetch failed for demo demo_123; falling back to curated content: serp down',
    );
    expect(result).toEqual({
      result: {
        reviews: [fallbackReview],
        responses: [fallbackResponse],
        metadata: { totalCostUsd: 0 },
      },
      source: 'curated_fallback',
    });
  });

  it('logs the existing warning and returns curated fallback when review selection fails', async () => {
    const logger = { warn: vi.fn() };
    vi.mocked(fetchSerpApiReviews).mockResolvedValue([review()]);
    vi.mocked(selectQualifyingReviews).mockImplementation(() => {
      throw new Error('selection failed');
    });

    const result = await buildOnboardingDemoSource({
      demoId: 'demo_123',
      googlePlaceId: validPlaceId,
      businessName: 'RepWorth Cafe',
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'SerpAPI fetch failed for demo demo_123; falling back to curated content: selection failed',
    );
    expect(result.source).toBe('curated_fallback');
  });

  it('generates responses and returns SerpAPI source when selected reviews include a 4+ star anchor', async () => {
    const selected = [review({ starRating: 4 })];
    const generated = {
      reviews: selected,
      responses: [response({ responseText: 'Generated response' })],
      metadata: { totalCostUsd: 0.03 },
    };
    vi.mocked(fetchSerpApiReviews).mockResolvedValue([review()]);
    vi.mocked(selectQualifyingReviews).mockReturnValue(selected);
    vi.mocked(generateResponsesForReviews).mockResolvedValue(generated);

    const result = await buildOnboardingDemoSource({
      demoId: 'demo_123',
      googlePlaceId: validPlaceId,
      businessName: 'RepWorth Cafe',
      category: 'Cafe',
      logger: { warn: vi.fn() },
    });

    expect(generateResponsesForReviews).toHaveBeenCalledWith(selected, {
      name: 'RepWorth Cafe',
      category: 'Cafe',
    });
    expect(result).toEqual({ result: generated, source: 'serpapi' });
  });

  it('returns curated fallback when selected reviews do not include a 4+ star anchor', async () => {
    vi.mocked(fetchSerpApiReviews).mockResolvedValue([review()]);
    vi.mocked(selectQualifyingReviews).mockReturnValue([review({ starRating: 3 })]);

    const result = await buildOnboardingDemoSource({
      demoId: 'demo_123',
      googlePlaceId: validPlaceId,
      businessName: 'RepWorth Cafe',
      category: 'Cafe',
      logger: { warn: vi.fn() },
    });

    expect(generateResponsesForReviews).not.toHaveBeenCalled();
    expect(getFallbackDemo).toHaveBeenCalledWith('Cafe');
    expect(result.source).toBe('curated_fallback');
  });
});

describe('failOnboardingDemoTerminal', () => {
  beforeEach(() => {
    vi.mocked(failDemo).mockReset();
  });

  it('calls failDemo for onboarding demos with the provided outbox handle and error', async () => {
    const error = new Error('boom');
    vi.mocked(failDemo).mockResolvedValue(undefined);

    await failOnboardingDemoTerminal({
      demoId: 'demo_123',
      outboxId: 'outbox_123',
      outboxAttempt: 2,
      error,
      logger: { error: vi.fn() },
    });

    expect(failDemo).toHaveBeenCalledWith(
      'onboarding_demos',
      'demo_123',
      'outbox_123',
      2,
      error,
    );
  });

  it('logs subscription-state transaction failures and rethrows', async () => {
    const logger = { error: vi.fn() };
    vi.mocked(failDemo).mockRejectedValue(new Error('tx failed'));

    await expect(
      failOnboardingDemoTerminal({
        demoId: 'demo_123',
        outboxId: 'outbox_123',
        outboxAttempt: undefined,
        error: new Error('subscription_state_changed'),
        logger,
      }),
    ).rejects.toThrow('tx failed');

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to record subscription_state_changed for demo demo_123: tx failed',
    );
  });

  it('logs generic transaction failures and rethrows', async () => {
    const logger = { error: vi.fn() };
    vi.mocked(failDemo).mockRejectedValue(new Error('tx failed'));

    await expect(
      failOnboardingDemoTerminal({
        demoId: 'demo_123',
        outboxId: 'outbox_123',
        outboxAttempt: 1,
        error: new Error('provider failed'),
        logger,
      }),
    ).rejects.toThrow('tx failed');

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to record failure for demo demo_123: tx failed',
    );
  });
});
