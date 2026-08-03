import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { getAdminJobsData } from '../jobs-service';

describe('getAdminJobsData', () => {
  it('returns the outbox summary, failed-jobs page, and failed total from the three queries', async () => {
    resetMockSql();
    sqlReturnQueue.push([{ pending: 1, dispatching: 2, dispatched: 3, failed: 4, completed_today: 5 }]);
    sqlReturnQueue.push([
      {
        id: 'job-1',
        topic: 'send_notification',
        last_error: 'boom',
        attempts: 2,
        max_attempts: 5,
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]);
    sqlReturnQueue.push([{ total: 4 }]);

    const data = await getAdminJobsData(mockSql as unknown as Sql, { limit: 20, offset: 0 });

    expect(data).toEqual({
      outbox: { pending: 1, dispatching: 2, dispatched: 3, failed: 4, completedToday: 5 },
      failedJobs: [
        {
          id: 'job-1',
          topic: 'send_notification',
          lastError: 'boom',
          attempts: 2,
          maxAttempts: 5,
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      failedTotal: 4,
    });

    expect(sqlCalls[0]!.text).toContain('FROM job_outbox');
    expect(sqlCalls[1]!.text).toContain('FROM job_outbox');
    expect(sqlCalls[1]!.text).toContain("status = 'failed'");
    expect(sqlCalls[1]!.values).toEqual([20, 0]);
    expect(sqlCalls[2]!.text).toContain('FROM job_outbox');
    expect(sqlCalls[2]!.text).toContain("status = 'failed'");
  });

  it('returns zeroed defaults for empty results', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const data = await getAdminJobsData(mockSql as unknown as Sql, { limit: 20, offset: 0 });

    expect(data).toEqual({
      outbox: { pending: 0, dispatching: 0, dispatched: 0, failed: 0, completedToday: 0 },
      failedJobs: [],
      failedTotal: 0,
    });
  });
});
