import { describe, it, expect, vi, beforeEach } from 'vitest';

import { queryBacklogDepth, BACKLOG_DEPTH_TABLES } from '../backlog-depth';

// Tagged-template sql mock (mirrors ZernioRecentReviewPoller.test.ts): a vi.fn
// that resolves the next queued row set. queryBacklogDepth now runs the count
// inside sql.begin(), so:
//  - `.begin(cb)` runs the callback against the SAME tagged-template stub as tx
//    (the transaction body issues the SELECT through the same mock).
//  - `.unsafe(text)` records the SET LOCAL statement_timeout call — the F-high
//    regression guard proving the DB op itself is bounded.
// We inspect mockSql.mock.calls to pin the assembled SELECT text (the SELECT is
// the only tagged-template call; `.unsafe` goes through the separate unsafe fn).
const { sqlReturnQueue, unsafeCalls, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const unsafeCalls: string[] = [];
  const shiftFrom = (queue: unknown[]) => {
    const next = queue.shift() ?? [];
    return Promise.resolve(Array.isArray(next) ? next : [next]);
  };
  const mockSql: any = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) =>
    shiftFrom(sqlReturnQueue),
  );
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => unknown) => cb(mockSql));
  mockSql.unsafe = vi.fn((text: string) => {
    unsafeCalls.push(text);
    return Promise.resolve([]);
  });
  return { sqlReturnQueue, unsafeCalls, mockSql };
});

describe('queryBacklogDepth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    unsafeCalls.length = 0;
  });

  it('exposes the two dispatch-queue tables verbatim', () => {
    expect(BACKLOG_DEPTH_TABLES).toEqual(['job_outbox', 'analytics_events']);
  });

  it('maps the single result row to { job_outbox, analytics_events }', async () => {
    sqlReturnQueue.push([{ job_outbox: 7, analytics_events: 3 }]);
    const depth = await queryBacklogDepth(mockSql);
    expect(depth).toEqual({ job_outbox: 7, analytics_events: 3 });
  });

  it('defaults to { 0, 0 } when the transaction yields no row', async () => {
    sqlReturnQueue.push([]);
    const depth = await queryBacklogDepth(mockSql);
    expect(depth).toEqual({ job_outbox: 0, analytics_events: 0 });
  });

  it('runs the count inside exactly one transaction (single sql.begin)', async () => {
    sqlReturnQueue.push([{ job_outbox: 0, analytics_events: 0 }]);
    await queryBacklogDepth(mockSql);
    expect(mockSql.begin).toHaveBeenCalledTimes(1);
  });

  it('bounds the DB op: SET LOCAL statement_timeout = 4000 (F-high regression guard)', async () => {
    sqlReturnQueue.push([{ job_outbox: 0, analytics_events: 0 }]);
    await queryBacklogDepth(mockSql);
    expect(mockSql.unsafe).toHaveBeenCalledTimes(1);
    expect(unsafeCalls[0]).toContain('SET LOCAL statement_timeout = 4000');
  });

  it('pins SQL semantics: pending predicate on both tables, ::int cast, no available_at filter', async () => {
    sqlReturnQueue.push([{ job_outbox: 0, analytics_events: 0 }]);
    await queryBacklogDepth(mockSql);

    // The SELECT is the only tagged-template invocation of mockSql (SET LOCAL
    // goes through mockSql.unsafe), so mock.calls[0] is the count query.
    const strings = mockSql.mock.calls[0][0] as TemplateStringsArray;
    const text = Array.from(strings).join('');

    // Total pending (glossary): status = 'pending' with no claimable-only filter.
    expect(text).toContain('FROM job_outbox');
    expect(text).toContain('FROM analytics_events');
    expect(text.match(/status = 'pending'/g) ?? []).toHaveLength(2);
    expect(text).toContain('::int');
    expect(text).not.toContain('available_at');
  });
});
