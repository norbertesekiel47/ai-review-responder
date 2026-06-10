// worker/jobs/response-generation/__tests__/load-context-fixtures.ts
//
// Shared row factories for the loadGenerationContext SQL projections.
// load-context.test.ts and ResponseGeneratorWorker.test.ts both feed these
// rows into their sql mocks; a single owner — typed against the exported
// GenerationReviewRow / GenerationBusinessRow projection types — keeps the
// projection shape (incl. archived_at, added with the archived-location gate)
// from drifting between suites. A column added to the SELECT without updating
// the row type (and therefore these defaults) fails typecheck.

import { asLocationId } from '../../../../src/lib/shared/ids';
import type { GenerationReviewRow, GenerationBusinessRow } from '../load-context';

export const FIXTURE_REVIEW_ID = 'rev-1';
export const FIXTURE_BUSINESS_ID = asLocationId('biz-1');
export const FIXTURE_ACCOUNT_ID = 'acct-1';

export function makeLoadContextReviewRow(
  overrides: Partial<GenerationReviewRow> = {},
): GenerationReviewRow {
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
  overrides: Partial<GenerationBusinessRow> = {},
): GenerationBusinessRow {
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
