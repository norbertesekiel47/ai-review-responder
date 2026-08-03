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
});
