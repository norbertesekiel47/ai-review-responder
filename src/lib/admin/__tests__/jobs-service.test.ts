import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { getAdminJobsData, parseJobsTopicFilter } from '../jobs-service';

const failedRow = {
  id: 'job-1',
  topic: 'send_notification',
  last_error: 'boom',
  attempts: 2,
  max_attempts: 5,
  created_at: new Date('2026-08-01T00:00:00.000Z'),
  business_id: 'biz-1',
  business_name: 'Downtown Cafe',
};

describe('getAdminJobsData', () => {
  it('returns the outbox summary, failed-jobs page (with business), failed total and topics from four sequential queries', async () => {
    resetMockSql();
    sqlReturnQueue.push([{ pending: 1, dispatching: 2, dispatched: 3, failed: 4, completed_today: 5 }]);
    sqlReturnQueue.push([failedRow]);
    sqlReturnQueue.push([{ total: 4 }]);
    sqlReturnQueue.push([{ topic: 'publish_response' }, { topic: 'send_notification' }]);

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
          businessId: 'biz-1',
          businessName: 'Downtown Cafe',
        },
      ],
      failedTotal: 4,
      failedTopics: ['publish_response', 'send_notification'],
    });

    expect(sqlCalls).toHaveLength(4);
    expect(sqlCalls[0]!.text).toContain('FROM job_outbox');
    // The page resolves the business through the payload id, UUID-guarded
    // before the cast so a platform-wide payload yields NULL, not 22P02.
    expect(sqlCalls[1]!.text).toContain('FROM job_outbox jo');
    expect(sqlCalls[1]!.text).toContain("LEFT JOIN businesses b ON b.id = CASE");
    expect(sqlCalls[1]!.text).toContain("jo.payload->>'businessId'");
    expect(sqlCalls[1]!.text).toContain("WHERE jo.status = 'failed'");
    expect(sqlCalls[1]!.text).not.toContain('jo.topic = ?');
    expect(sqlCalls[1]!.values).toEqual([20, 0]);
    expect(sqlCalls[2]!.text).toContain("WHERE jo.status = 'failed'");
    expect(sqlCalls[2]!.values).toEqual([]);
    expect(sqlCalls[3]!.text).toContain("SELECT DISTINCT topic FROM job_outbox WHERE status = 'failed'");
  });

  it('applies the topic filter to the page AND its count, never to the topic list', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([failedRow]);
    sqlReturnQueue.push([{ total: 1 }]);
    sqlReturnQueue.push([{ topic: 'publish_response' }, { topic: 'send_notification' }]);

    const data = await getAdminJobsData(mockSql as unknown as Sql, {
      limit: 20,
      offset: 0,
      topic: 'send_notification',
    });

    expect(sqlCalls[1]!.text).toContain("WHERE jo.status = 'failed' AND jo.topic = ?");
    expect(sqlCalls[1]!.values).toEqual(['send_notification', 20, 0]);
    expect(sqlCalls[2]!.text).toContain("WHERE jo.status = 'failed' AND jo.topic = ?");
    expect(sqlCalls[2]!.values).toEqual(['send_notification']);
    // The options list stays unfiltered so the operator can switch topics.
    expect(sqlCalls[3]!.text).not.toContain('topic = ?');
    expect(data.failedTopics).toEqual(['publish_response', 'send_notification']);
  });

  it('maps a row with no resolvable business to null business fields', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ ...failedRow, business_id: null, business_name: null }]);
    sqlReturnQueue.push([{ total: 1 }]);
    sqlReturnQueue.push([]);

    const data = await getAdminJobsData(mockSql as unknown as Sql, { limit: 20, offset: 0 });
    expect(data.failedJobs[0]).toMatchObject({ businessId: null, businessName: null });
  });

  it('returns zeroed defaults for empty results', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const data = await getAdminJobsData(mockSql as unknown as Sql, { limit: 20, offset: 0 });

    expect(data).toEqual({
      outbox: { pending: 0, dispatching: 0, dispatched: 0, failed: 0, completedToday: 0 },
      failedJobs: [],
      failedTotal: 0,
      failedTopics: [],
    });
  });
});

describe('parseJobsTopicFilter', () => {
  it('accepts a lower-snake-case topic and drops anything else', () => {
    expect(parseJobsTopicFilter('send_notification')).toBe('send_notification');
    expect(parseJobsTopicFilter(' publish_response ')).toBe('publish_response');
    expect(parseJobsTopicFilter('')).toBeUndefined();
    expect(parseJobsTopicFilter(null)).toBeUndefined();
    expect(parseJobsTopicFilter("send' OR 1=1")).toBeUndefined();
    expect(parseJobsTopicFilter('Send_Notification')).toBeUndefined();
    expect(parseJobsTopicFilter('a'.repeat(65))).toBeUndefined();
  });
});
