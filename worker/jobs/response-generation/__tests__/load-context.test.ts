import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Sql } from 'postgres';

// ── Hoisted shared sql mock (worker/__tests__/helpers/mock-sql) ──────────
const { sqlReturnQueue, mockSql, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

// loadGenerationContext now takes the injected client as its leading arg; the
// db/server mock is retained for load-context's transitive imports (e.g. the
// offboarding gate), and the same mock drives the FIFO return queue.
vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

const sqlArg = mockSql as unknown as Sql;

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
    resetMockSql();
  });

  it('returns skipped with the archived_location reason when the business is archived', async () => {
    sqlReturnQueue.push([makeLoadContextReviewRow()]);
    sqlReturnQueue.push([makeLoadContextBusinessRow({ archived_at: new Date('2026-06-01T00:00:00Z') })]);
    sqlReturnQueue.push([]); // existing-response idempotency lookup → none

    const out = await loadGenerationContext(sqlArg, {
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

    const out = await loadGenerationContext(sqlArg, {
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

    const out = await loadGenerationContext(sqlArg, {
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
      processingBlocked: false,
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

    const out = await loadGenerationContext(sqlArg, {
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
      processingBlocked: false,
    });
  });

  // An already-committed response on an account in active processing-blocking
  // offboarding (delete_data) still resolves already_exists — the work WAS
  // done — but processingBlocked must be true so the caller suppresses the
  // durable first_response_drafted enqueue (the analytics dispatch poller has
  // no offboarding gate and would export the event for an account mid-purge).
  it('returns already_exists with processingBlocked true when the account is in active delete_data offboarding', async () => {
    sqlReturnQueue.push([makeLoadContextReviewRow()]);
    sqlReturnQueue.push([makeLoadContextBusinessRow({
      offboarding_id: 'offboarding-1',
      offboarding_account_id: FIXTURE_ACCOUNT_ID,
      offboarding_mode: 'delete_data',
      offboarding_status: 'pending',
      offboarding_failed_step: null,
      offboarding_access_ends_at: null,
      offboarding_teardown_started_at: null,
      offboarding_purge_after: null,
      offboarding_purge_started_at: null,
      offboarding_purge_cancelled_at: null,
    })]);
    sqlReturnQueue.push([{
      id: 'resp-existing-1',
      business_id: FIXTURE_BUSINESS_ID,
      account_id: FIXTURE_ACCOUNT_ID,
    }]);

    const out = await loadGenerationContext(sqlArg, {
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
      processingBlocked: true,
    });
  });

  it('returns ready for a non-archived active business (regression)', async () => {
    sqlReturnQueue.push([makeLoadContextReviewRow()]);
    sqlReturnQueue.push([makeLoadContextBusinessRow()]);
    sqlReturnQueue.push([]); // existing-response idempotency lookup → none

    const out = await loadGenerationContext(sqlArg, {
      reviewId: FIXTURE_REVIEW_ID,
      businessId: FIXTURE_BUSINESS_ID,
      version: 1,
    });

    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.ctx.subscriptionTier).toBe('autopilot');
      expect(out.ctx.businessContext.subscriptionTier).toBe('autopilot');
    }
  });

  it('fails closed on a legacy tier instead of casting or mapping it', async () => {
    sqlReturnQueue.push([makeLoadContextReviewRow()]);
    sqlReturnQueue.push([makeLoadContextBusinessRow({ subscription_tier: 'premium' })]);
    sqlReturnQueue.push([]);

    await expect(loadGenerationContext(sqlArg, {
      reviewId: FIXTURE_REVIEW_ID,
      businessId: FIXTURE_BUSINESS_ID,
      version: 1,
    })).rejects.toThrow('invalid_ws8_subscription_tier:premium');
  });
});
