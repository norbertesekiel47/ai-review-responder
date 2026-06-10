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
import { asLocationId } from '../../../../src/lib/shared/ids';

const RID = 'rev-1';
const BID = asLocationId('biz-1');
const AID = 'acct-1';

function mockReviewRow(overrides = {}) {
  return {
    id: RID,
    reviewer_name: 'Jane',
    star_rating: 5,
    review_text: 'Great!',
    review_date: '2026-04-01',
    detected_language: 'en',
    review_content_hash: 'hash-loaded',
    ...overrides,
  };
}

function mockBusinessRow(overrides = {}) {
  return {
    id: BID,
    account_id: AID,
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

describe('loadGenerationContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('returns archived_location when the business is archived', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow({ archived_at: '2026-06-01T00:00:00Z' })]);

    const out = await loadGenerationContext({ reviewId: RID, businessId: BID, version: 1 });

    expect(out.kind).toBe('archived_location');
  });

  it('returns ready for a non-archived active business (regression)', async () => {
    sqlReturnQueue.push([mockReviewRow()]);
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([]); // existing-response idempotency lookup → none

    const out = await loadGenerationContext({ reviewId: RID, businessId: BID, version: 1 });

    expect(out.kind).toBe('ready');
  });
});
