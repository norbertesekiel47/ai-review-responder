import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted sql mock (mirrors ResponseGeneratorWorker.test.ts convention) ──
const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });
  return { sqlReturnQueue, mockSql };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

import { loadGenerationContext } from '../load-context';
import { SKIP_REASON_ARCHIVED_LOCATION } from '../../../../src/lib/shared/worker-types';
import {
  FIXTURE_REVIEW_ID,
  FIXTURE_BUSINESS_ID,
  FIXTURE_ACCOUNT_ID,
  makeLoadContextReviewRow,
  makeLoadContextBusinessRow,
} from './load-context-fixtures';

describe('loadGenerationContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('returns skipped with the archived_location reason when the business is archived', async () => {
    sqlReturnQueue.push([makeLoadContextReviewRow()]);
    sqlReturnQueue.push([makeLoadContextBusinessRow({ archived_at: new Date('2026-06-01T00:00:00Z') })]);
    sqlReturnQueue.push([]); // existing-response idempotency lookup → none

    const out = await loadGenerationContext({
      reviewId: FIXTURE_REVIEW_ID,
      businessId: FIXTURE_BUSINESS_ID,
      version: 1,
    });

    expect(out).toEqual({ kind: 'skipped', reason: SKIP_REASON_ARCHIVED_LOCATION });
  });

  it('returns skipped with the subscription-guard reason for a cancelled subscription', async () => {
    sqlReturnQueue.push([makeLoadContextReviewRow()]);
    sqlReturnQueue.push([makeLoadContextBusinessRow({ subscription_status: 'cancelled' })]);
    sqlReturnQueue.push([]); // existing-response idempotency lookup → none

    const out = await loadGenerationContext({
      reviewId: FIXTURE_REVIEW_ID,
      businessId: FIXTURE_BUSINESS_ID,
      version: 1,
    });

    expect(out).toEqual({ kind: 'skipped', reason: 'cancelled' });
  });

  // FIX 2 regression: the idempotency check must run BEFORE the archived
  // gate so a crash-retry whose response was committed pre-archive resolves
  // as already_exists (preserving the caller's first_response_drafted
  // recovery) instead of being silently dropped as a skip.
  it('returns already_exists (not skipped) when the response was committed before the location was archived', async () => {
    sqlReturnQueue.push([makeLoadContextReviewRow()]);
    sqlReturnQueue.push([makeLoadContextBusinessRow({ archived_at: new Date('2026-06-01T00:00:00Z') })]);
    sqlReturnQueue.push([{
      id: 'resp-existing-1',
      business_id: FIXTURE_BUSINESS_ID,
      account_id: FIXTURE_ACCOUNT_ID,
    }]);

    const out = await loadGenerationContext({
      reviewId: FIXTURE_REVIEW_ID,
      businessId: FIXTURE_BUSINESS_ID,
      version: 1,
    });

    expect(out.kind).toBe('already_exists');
    expect(out).toMatchObject({
      existing: {
        id: 'resp-existing-1',
        businessId: FIXTURE_BUSINESS_ID,
        accountId: FIXTURE_ACCOUNT_ID,
      },
    });
  });

  // The idempotency check also precedes the subscription/offboarding guards:
  // a response already committed on a now-cancelled account resolves
  // already_exists (the work WAS done; recovery analytics still fire)
  // instead of being skipped.
  it('returns already_exists (not skipped) when the response was committed before the subscription was cancelled', async () => {
    sqlReturnQueue.push([makeLoadContextReviewRow()]);
    sqlReturnQueue.push([makeLoadContextBusinessRow({ subscription_status: 'cancelled' })]);
    sqlReturnQueue.push([{
      id: 'resp-existing-1',
      business_id: FIXTURE_BUSINESS_ID,
      account_id: FIXTURE_ACCOUNT_ID,
    }]);

    const out = await loadGenerationContext({
      reviewId: FIXTURE_REVIEW_ID,
      businessId: FIXTURE_BUSINESS_ID,
      version: 1,
    });

    expect(out.kind).toBe('already_exists');
    expect(out).toMatchObject({
      existing: {
        id: 'resp-existing-1',
        businessId: FIXTURE_BUSINESS_ID,
        accountId: FIXTURE_ACCOUNT_ID,
      },
    });
  });

  it('returns ready for a non-archived active business (regression)', async () => {
    sqlReturnQueue.push([makeLoadContextReviewRow()]);
    sqlReturnQueue.push([makeLoadContextBusinessRow()]);
    sqlReturnQueue.push([]); // existing-response idempotency lookup → none

    const out = await loadGenerationContext({
      reviewId: FIXTURE_REVIEW_ID,
      businessId: FIXTURE_BUSINESS_ID,
      version: 1,
    });

    expect(out.kind).toBe('ready');
  });
});
