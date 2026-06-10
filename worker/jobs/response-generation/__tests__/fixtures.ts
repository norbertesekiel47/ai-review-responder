// worker/jobs/response-generation/__tests__/fixtures.ts
//
// Shared row factories for the loadGenerationContext SQL projection.
// load-context.test.ts and ResponseGeneratorWorker.test.ts both feed these
// rows into their sql mocks; a single owner keeps the projection shape
// (incl. archived_at, added with the archived-location gate) from drifting
// between suites — the worker suite previously omitted archived_at and only
// passed via undefined-falsy.

import { asLocationId } from '../../../../src/lib/shared/ids';

export const FIXTURE_REVIEW_ID = 'rev-1';
export const FIXTURE_BUSINESS_ID = asLocationId('biz-1');
export const FIXTURE_ACCOUNT_ID = 'acct-1';

export function makeLoadContextReviewRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: FIXTURE_REVIEW_ID,
    reviewer_name: 'Jane',
    star_rating: 5,
    review_text: 'Great!',
    review_date: '2026-04-01',
    detected_language: 'en',
    review_content_hash: 'hash-loaded',
    ...overrides,
  };
}

export function makeLoadContextBusinessRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: FIXTURE_BUSINESS_ID,
    account_id: FIXTURE_ACCOUNT_ID,
    name: 'Test Biz',
    category: 'restaurant',
    tone: 'warm',
    products_services: null,
    staff_names: [],
    highlight_facts: [],
    avoid_facts: [],
    sample_responses: [],
    subscription_status: 'active',
    subscription_tier: 'standard',
    account_past_due_at: null,
    account_flags: {},
    archived_at: null,
    ...overrides,
  };
}
