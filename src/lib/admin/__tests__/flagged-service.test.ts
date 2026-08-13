import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { listOpenFlaggedResponses } from '../flagged-service';

describe('listOpenFlaggedResponses', () => {
  it('queries the open queue with limit/offset and returns the display shape', async () => {
    resetMockSql();
    sqlReturnQueue.push([
      {
        id: 'flag-1',
        response_id: 'resp-1',
        business_id: 'biz-1',
        account_id: 'acct-1',
        review_id: 'rev-1',
        source: 'local_regex',
        reason: 'refund_discount',
        severity: 'high',
        status: 'open',
        created_at: new Date('2026-05-26T00:00:00.000Z'),
        response_text: 'Here is a full refund.',
        version: 1,
        reviewer_name: 'Jane',
        star_rating: 2,
        business_name: 'Bella Italia',
      },
    ]);
    sqlReturnQueue.push([{ total: 137 }]);

    const data = await listOpenFlaggedResponses(mockSql as unknown as Sql, { limit: 50, offset: 0 });

    expect(data).toEqual({
      flagged: [
        {
          id: 'flag-1',
          responseId: 'resp-1',
          businessId: 'biz-1',
          accountId: 'acct-1',
          reviewId: 'rev-1',
          source: 'local_regex',
          reason: 'refund_discount',
          severity: 'high',
          status: 'open',
          createdAt: '2026-05-26T00:00:00.000Z',
          responseText: 'Here is a full refund.',
          version: 1,
          reviewerName: 'Jane',
          starRating: 2,
          businessName: 'Bella Italia',
        },
      ],
      total: 137,
    });

    expect(sqlCalls[0]!.text).toContain("WHERE fr.status = 'open'");
    expect(sqlCalls[0]!.values).toEqual([50, 0]);
    expect(sqlCalls[1]!.text).toContain('FROM flagged_responses');
    expect(sqlCalls[1]!.text).toContain("WHERE status = 'open'");
  });

  it('returns zeroed defaults for empty results', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const data = await listOpenFlaggedResponses(mockSql as unknown as Sql, { limit: 50, offset: 0 });

    expect(data).toEqual({ flagged: [], total: 0 });
  });

  // #773 regression. The page and count reads must NEVER be in flight together:
  // 2 concurrent queries per request against Vercel's DB_POOL_MAX=3 is what
  // wedged a Fluid Compute isolate's pool slot on staging (2026-08-13 evidence).
  // Holding the page query pending and asserting the count has NOT been issued
  // is the discriminator — under `Promise.all` both record before either settles.
  it('issues the count only after the page query settles (one query in flight)', async () => {
    resetMockSql();
    let releasePage!: (rows: unknown) => void;
    sqlReturnQueue.push(new Promise((resolve) => { releasePage = resolve; }));
    sqlReturnQueue.push([{ total: 7 }]);

    const pending = listOpenFlaggedResponses(mockSql as unknown as Sql, { limit: 50, offset: 0 });

    // Flush microtasks AND a macrotask turn: ample time for a concurrent
    // fan-out to have registered its second query.
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.text).toContain("WHERE fr.status = 'open'");

    releasePage([]);
    const data = await pending;

    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[1]!.text).toContain('COUNT(*)::int AS total');
    expect(data.total).toBe(7);
  });

  // The reason this fix does NOT collapse into a single `COUNT(*) OVER ()`
  // round trip: an empty page must still report the true total.
  it('keeps the total exact when the page is empty (offset past the end)', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ total: 5 }]);

    const data = await listOpenFlaggedResponses(mockSql as unknown as Sql, { limit: 20, offset: 100 });

    expect(data).toEqual({ flagged: [], total: 5 });
  });
});
