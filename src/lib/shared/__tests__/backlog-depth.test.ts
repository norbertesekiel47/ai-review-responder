import { describe, it, expect, vi, beforeEach } from 'vitest';

import { queryBacklogDepth, BACKLOG_DEPTH_TABLES } from '../backlog-depth';

// Tagged-template sql mock (mirrors health-alert checks.test.ts): a vi.fn that
// resolves the next queued row set. We also inspect mock.calls to pin the
// assembled SQL text — the TemplateStringsArray is the first call arg.
const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const shiftFrom = (queue: unknown[]) => {
    const next = queue.shift() ?? [];
    return Promise.resolve(Array.isArray(next) ? next : [next]);
  };
  const mockSql: any = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) =>
    shiftFrom(sqlReturnQueue),
  );
  return { sqlReturnQueue, mockSql };
});

describe('queryBacklogDepth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('exposes the two dispatch-queue tables verbatim', () => {
    expect(BACKLOG_DEPTH_TABLES).toEqual(['job_outbox', 'analytics_events']);
  });

  it('maps the single result row to { job_outbox, analytics_events }', async () => {
    sqlReturnQueue.push([{ job_outbox: 7, analytics_events: 3 }]);
    const depth = await queryBacklogDepth(mockSql);
    expect(depth).toEqual({ job_outbox: 7, analytics_events: 3 });
  });

  it('runs exactly one tagged-template query (single round-trip)', async () => {
    sqlReturnQueue.push([{ job_outbox: 0, analytics_events: 0 }]);
    await queryBacklogDepth(mockSql);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('pins SQL semantics: pending predicate on both tables, ::int cast, no available_at filter', async () => {
    sqlReturnQueue.push([{ job_outbox: 0, analytics_events: 0 }]);
    await queryBacklogDepth(mockSql);

    const strings = mockSql.mock.calls[0][0] as TemplateStringsArray;
    const text = Array.from(strings).join('');

    // Total pending (glossary): status = 'pending' with no claimable-only filter.
    expect(text).toContain("FROM job_outbox");
    expect(text).toContain("FROM analytics_events");
    expect(text.match(/status = 'pending'/g) ?? []).toHaveLength(2);
    expect(text).toContain('::int');
    expect(text).not.toContain('available_at');
  });
});
