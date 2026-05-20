import { describe, expect, it } from 'vitest';
import {
  buildDashboardUrl,
  calculateBaselineResponseRate,
  mapSummaryReviews,
} from '../summary-report-helpers';

describe('summary report helpers', () => {
  it('calculates a rounded baseline response rate when baseline data is complete', () => {
    expect(
      calculateBaselineResponseRate({
        baseline_captured_at: new Date('2026-01-01'),
        initial_review_count: 37,
        initial_responded_count: 18,
      }),
    ).toBe(49);
  });

  it('returns null when baseline data is incomplete', () => {
    expect(
      calculateBaselineResponseRate({
        baseline_captured_at: null,
        initial_review_count: 37,
        initial_responded_count: 18,
      }),
    ).toBeNull();
    expect(
      calculateBaselineResponseRate({
        baseline_captured_at: new Date('2026-01-01'),
        initial_review_count: 0,
        initial_responded_count: 18,
      }),
    ).toBeNull();
  });

  it('only builds dashboard URLs when the owner has auth and app URL is configured', () => {
    expect(buildDashboardUrl([{ exists: 1 }], 'https://app.repworth.com')).toBe(
      'https://app.repworth.com/dashboard',
    );
    expect(buildDashboardUrl([], 'https://app.repworth.com')).toBeNull();
    expect(buildDashboardUrl([{ exists: 1 }], undefined)).toBeNull();
  });

  it('maps review rows into the LLM summary shape', () => {
    expect(
      mapSummaryReviews([
        { star_rating: 5, review_text: 'Great' },
        { star_rating: 2, review_text: null },
      ]),
    ).toEqual([
      { starRating: 5, reviewText: 'Great' },
      { starRating: 2, reviewText: null },
    ]);
  });
});
