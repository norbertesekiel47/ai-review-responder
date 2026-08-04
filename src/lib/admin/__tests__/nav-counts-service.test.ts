import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { getAdminNavCounts } from '../nav-counts-service';

describe('getAdminNavCounts', () => {
  it('returns both counts from the two COUNT queries', async () => {
    resetMockSql();
    sqlReturnQueue.push([{ total: 3 }]);
    sqlReturnQueue.push([{ total: 1 }]);

    const counts = await getAdminNavCounts(mockSql as unknown as Sql);

    expect(counts).toEqual({ flaggedOpen: 3, failedJobs: 1 });
    expect(sqlCalls[0]!.text).toContain('flagged_responses');
    expect(sqlCalls[0]!.text).toContain("status = 'open'");
    expect(sqlCalls[1]!.text).toContain('job_outbox');
    expect(sqlCalls[1]!.text).toContain("status = 'failed'");
  });

  it('returns zeros for empty results', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const counts = await getAdminNavCounts(mockSql as unknown as Sql);

    expect(counts).toEqual({ flaggedOpen: 0, failedJobs: 0 });
  });
});
