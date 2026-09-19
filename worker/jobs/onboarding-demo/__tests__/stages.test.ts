import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { releaseOnboardingDemoReservation } from '../reservation';
import { resolveOnboardingDemoPlaceId } from '../place-resolution';
import { buildOnboardingDemoSource } from '../demo-source';
import { failOnboardingDemoTerminal } from '../terminal';
import { guardOnboardingDemoSubscription } from '../subscription-guard';
import {
  finalizeOnboardingDemoSpend,
  reportOnboardingDemoCostThresholds,
} from '../cost-reconcile';
import { SubscriptionStatus } from '../../../../src/lib/shared/subscription-status';
import * as Sentry from '@sentry/node';
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

// Sentry is a sink, not a decision — cost-reconcile.ts imports it directly,
// matching terminal.ts's direct import of failDemo. It appears nowhere else in
// this package, so mocking it file-wide affects no other describe block.
vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
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
  // buildOnboardingDemoSource now takes the injected client as its leading arg;
  // it is only forwarded to the mocked generateResponsesForReviews here.
  const mockSql = {} as unknown as Sql;

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

    const result = await buildOnboardingDemoSource(mockSql, {
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

    const result = await buildOnboardingDemoSource(mockSql, {
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
      metadata: {
        totalReviews: 1,
        successfulResponses: 1,
        failedResponses: 0,
        totalCostUsd: 0.03,
        generationDurationMs: 125,
      },
    };
    vi.mocked(fetchSerpApiReviews).mockResolvedValue([review()]);
    vi.mocked(selectQualifyingReviews).mockReturnValue(selected);
    vi.mocked(generateResponsesForReviews).mockResolvedValue(generated);

    const result = await buildOnboardingDemoSource(mockSql, {
      demoId: 'demo_123',
      googlePlaceId: validPlaceId,
      businessName: 'RepWorth Cafe',
      category: 'Cafe',
      logger: { warn: vi.fn() },
    });

    expect(generateResponsesForReviews).toHaveBeenCalledWith(mockSql, selected, {
      name: 'RepWorth Cafe',
      category: 'Cafe',
    });
    expect(result).toEqual({ result: generated, source: 'serpapi' });
  });

  it('returns curated fallback when selected reviews do not include a 4+ star anchor', async () => {
    vi.mocked(fetchSerpApiReviews).mockResolvedValue([review()]);
    vi.mocked(selectQualifyingReviews).mockReturnValue([review({ starRating: 3 })]);

    const result = await buildOnboardingDemoSource(mockSql, {
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
  const mockSql = {} as unknown as Sql;

  beforeEach(() => {
    vi.mocked(failDemo).mockReset();
  });

  it('calls failDemo for onboarding demos with the provided outbox handle and error', async () => {
    const error = new Error('boom');
    vi.mocked(failDemo).mockResolvedValue(undefined);

    await failOnboardingDemoTerminal({
      sql: mockSql,
      demoId: 'demo_123',
      outboxId: 'outbox_123',
      outboxAttempt: 2,
      error,
      logger: { error: vi.fn() },
    });

    expect(failDemo).toHaveBeenCalledWith(
      mockSql,
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
        sql: mockSql,
        demoId: 'demo_123',
        outboxId: 'outbox_123',
        outboxAttempt: undefined,
        error: new Error('subscription_state_changed'),
        failureKind: 'subscription_state_changed',
        logger,
      }),
    ).rejects.toThrow('tx failed');

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to record subscription_state_changed for demo demo_123: tx failed',
    );
  });

  it('does not infer subscription-state logging from the error message alone', async () => {
    const logger = { error: vi.fn() };
    vi.mocked(failDemo).mockRejectedValue(new Error('tx failed'));

    await expect(
      failOnboardingDemoTerminal({
        sql: mockSql,
        demoId: 'demo_123',
        outboxId: 'outbox_123',
        outboxAttempt: undefined,
        error: new Error('subscription_state_changed'),
        logger,
      }),
    ).rejects.toThrow('tx failed');

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to record failure for demo demo_123: tx failed',
    );
  });

  it('logs generic transaction failures and rethrows', async () => {
    const logger = { error: vi.fn() };
    vi.mocked(failDemo).mockRejectedValue(new Error('tx failed'));

    await expect(
      failOnboardingDemoTerminal({
        sql: mockSql,
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

describe('guardOnboardingDemoSubscription', () => {
  /**
   * A tagged-template `sql` fake that CAPTURES the query it was handed. A fake
   * that returned the fixture regardless of the query could not detect a
   * dropped `od.id` predicate or a rewritten account join, which is exactly
   * what the scope test below has to catch.
   */
  function capturingSql(rows: unknown[]) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const fake = (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join(' ? ').replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve(rows);
    };
    return {
      sql: fake as unknown as Sql,
      lastQuery(): { text: string; values: unknown[] } {
        const call = calls.at(-1);
        if (!call) throw new Error('sql was never called');
        return call;
      },
    };
  }

  function makeLogger() {
    return { warn: vi.fn(), error: vi.fn() };
  }

  it('guardOnboardingDemoSubscription reports not handled when the account is still pending_payment', async () => {
    const { sql } = capturingSql([{ subscription_status: SubscriptionStatus.PENDING_PAYMENT }]);
    const failTerminal = vi.fn();
    const releaseReservation = vi.fn().mockResolvedValue(undefined);

    const handled = await guardOnboardingDemoSubscription({
      sql,
      demoId: 'demo_123',
      outboxId: 'outbox_123',
      outboxAttempt: undefined,
      logger: makeLogger(),
      releaseReservation,
      failTerminal,
    });

    expect(handled).toBe(false);
    expect(failTerminal).not.toHaveBeenCalled();
    expect(releaseReservation).not.toHaveBeenCalled();
  });

  it('guardOnboardingDemoSubscription reports not handled when the demo row is missing', async () => {
    // A missing row is NOT a changed subscription — the demo may have been
    // deleted. Failing it here would turn a clean `not_found` completion into
    // a spurious subscription_state_changed failure.
    const { sql } = capturingSql([]);
    const failTerminal = vi.fn();
    const releaseReservation = vi.fn().mockResolvedValue(undefined);

    const handled = await guardOnboardingDemoSubscription({
      sql,
      demoId: 'demo_123',
      outboxId: 'outbox_123',
      outboxAttempt: undefined,
      logger: makeLogger(),
      releaseReservation,
      failTerminal,
    });

    expect(handled).toBe(false);
    expect(failTerminal).not.toHaveBeenCalled();
    expect(releaseReservation).not.toHaveBeenCalled();
  });

  it('guardOnboardingDemoSubscription fails the demo and releases the reservation when the account has paid', async () => {
    const { sql } = capturingSql([{ subscription_status: SubscriptionStatus.ACTIVE }]);
    const failTerminal = vi.fn().mockResolvedValue(undefined);
    const releaseReservation = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();

    const handled = await guardOnboardingDemoSubscription({
      sql,
      demoId: 'demo_123',
      outboxId: 'outbox_123',
      outboxAttempt: undefined,
      logger,
      releaseReservation,
      failTerminal,
    });

    expect(handled).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'Demo demo_123 account status=active, marking failed',
    );
    expect(failTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ failureKind: 'subscription_state_changed' }),
    );
    expect(releaseReservation).toHaveBeenCalledTimes(1);
  });

  it('guardOnboardingDemoSubscription releases the reservation and re-throws when the terminal write fails', async () => {
    const { sql } = capturingSql([{ subscription_status: SubscriptionStatus.ACTIVE }]);
    const failTerminal = vi.fn().mockRejectedValue(new Error('tx failed'));
    const releaseReservation = vi.fn().mockResolvedValue(undefined);

    await expect(
      guardOnboardingDemoSubscription({
        sql,
        demoId: 'demo_123',
        outboxId: 'outbox_123',
        outboxAttempt: undefined,
        logger: makeLogger(),
        releaseReservation,
        failTerminal,
      }),
    ).rejects.toThrow('tx failed');

    // The finally releases BEFORE the re-throw propagates, exactly once.
    expect(releaseReservation).toHaveBeenCalledTimes(1);
  });

  it("guardOnboardingDemoSubscription reads status only through the demo's own business and account", async () => {
    const { sql, lastQuery } = capturingSql([
      { subscription_status: SubscriptionStatus.PENDING_PAYMENT },
    ]);

    await guardOnboardingDemoSubscription({
      sql,
      demoId: 'demo_123',
      outboxId: 'outbox_123',
      outboxAttempt: undefined,
      logger: makeLogger(),
      releaseReservation: vi.fn().mockResolvedValue(undefined),
      failTerminal: vi.fn(),
    });

    const { text, values } = lastQuery();
    expect(text).toContain('FROM onboarding_demos od');
    expect(text).toContain('JOIN businesses b ON b.id = od.business_id');
    expect(text).toContain('JOIN accounts a ON a.id = b.account_id');
    expect(text).toContain('WHERE od.id =');
    // The demo id is BOUND, not interpolated, and it is the only bound value.
    expect(values).toEqual(['demo_123']);
  });

  it('guardOnboardingDemoSubscription forwards the sql client, outbox id and numeric attempt to the terminal write', async () => {
    // Distinct ids and a NONZERO numeric attempt: failDemo only adds its
    // `AND attempts = $n` predicate when the attempt is a number, so losing it
    // would let a stale worker fail a newer dispatch.
    const { sql } = capturingSql([{ subscription_status: SubscriptionStatus.CANCELLED }]);
    const failTerminal = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();

    await guardOnboardingDemoSubscription({
      sql,
      demoId: 'demo_abc',
      outboxId: 'outbox_xyz',
      outboxAttempt: 3,
      logger,
      releaseReservation: vi.fn().mockResolvedValue(undefined),
      failTerminal,
    });

    expect(failTerminal).toHaveBeenCalledWith({
      sql,
      demoId: 'demo_abc',
      outboxId: 'outbox_xyz',
      outboxAttempt: 3,
      error: expect.any(Error),
      failureKind: 'subscription_state_changed',
      logger,
    });
  });
});

describe('finalizeOnboardingDemoSpend', () => {
  it('finalizeOnboardingDemoSpend does nothing without a reservation date', async () => {
    const finalizeCost = vi.fn();
    const logger = { error: vi.fn() };

    await finalizeOnboardingDemoSpend({
      reservationDate: undefined,
      totalCostUsd: 0.0342,
      logger,
      finalizeCost,
    });

    expect(finalizeCost).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('finalizeOnboardingDemoSpend swallows and logs a finalize failure', async () => {
    const logger = { error: vi.fn() };

    // Error branch of the diagnostic ternary.
    const errorFinalize = vi.fn().mockRejectedValue(new Error('redis down'));
    await expect(
      finalizeOnboardingDemoSpend({
        reservationDate: '2026-05-20',
        totalCostUsd: 0.0355,
        logger,
        finalizeCost: errorFinalize,
      }),
    ).resolves.toBeUndefined();

    // 3.55c ROUNDS UP to 4 — floor and trunc would book 3. Paired with the
    // 3.42c case below, which rounds DOWN to 3 and so kills ceil. One fixture
    // alone cannot pin the rounding contract. Red-team RT-001.
    expect(errorFinalize).toHaveBeenCalledWith('2026-05-20', 4);
    expect(logger.error).toHaveBeenNthCalledWith(
      1,
      'Failed to finalize cost reservation: redis down',
    );

    // Non-Error branch of the same ternary. Running both without asserting
    // their output would not preserve that output.
    const stringFinalize = vi.fn().mockRejectedValue('plain string');
    await expect(
      finalizeOnboardingDemoSpend({
        reservationDate: '2026-05-20',
        totalCostUsd: 0.0342,
        logger,
        finalizeCost: stringFinalize,
      }),
    ).resolves.toBeUndefined();

    // 3.42c rounds DOWN to 3 — ceil would book 4. This is the other half of
    // the rounding pin; together the two cases admit only Math.round.
    expect(stringFinalize).toHaveBeenCalledWith('2026-05-20', 3);
    expect(logger.error).toHaveBeenNthCalledWith(
      2,
      'Failed to finalize cost reservation: plain string',
    );
  });
});

describe('reportOnboardingDemoCostThresholds', () => {
  beforeEach(() => {
    vi.mocked(Sentry.captureMessage).mockReset();
  });

  it('reportOnboardingDemoCostThresholds checks the current UTC day with the exact lane and thresholds', async () => {
    const checkThreshold = vi.fn().mockResolvedValue({ crossed: [] });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T23:59:59.000Z'));

    try {
      await reportOnboardingDemoCostThresholds({
        demoId: 'demo_123',
        logger: { error: vi.fn() },
        checkThreshold,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(checkThreshold).toHaveBeenCalledWith('onboarding-demo', '2026-03-04', [50, 90, 100]);
  });

  it('reportOnboardingDemoCostThresholds captures one Sentry message per crossed threshold', async () => {
    const checkThreshold = vi.fn().mockResolvedValue({ crossed: [50, 90, 100] });

    await reportOnboardingDemoCostThresholds({
      demoId: 'demo_123',
      logger: { error: vi.fn() },
      checkThreshold,
    });

    // The level ladder and both tags are the operational contract an alert
    // routing rule depends on.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(3);
    expect(Sentry.captureMessage).toHaveBeenNthCalledWith(
      1,
      'onboarding_demo_cost_threshold_50',
      { level: 'info', tags: { lane: 'onboarding-demo', threshold: '50' } },
    );
    expect(Sentry.captureMessage).toHaveBeenNthCalledWith(
      2,
      'onboarding_demo_cost_threshold_90',
      { level: 'warning', tags: { lane: 'onboarding-demo', threshold: '90' } },
    );
    expect(Sentry.captureMessage).toHaveBeenNthCalledWith(
      3,
      'onboarding_demo_cost_threshold_100',
      { level: 'error', tags: { lane: 'onboarding-demo', threshold: '100' } },
    );
  });

  it('reportOnboardingDemoCostThresholds swallows and logs a threshold-check failure', async () => {
    const logger = { error: vi.fn() };

    await expect(
      reportOnboardingDemoCostThresholds({
        demoId: 'demo_123',
        logger,
        checkThreshold: vi.fn().mockRejectedValue(new Error('redis down')),
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Threshold check / Sentry capture failed for demo demo_123: redis down',
    );
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
