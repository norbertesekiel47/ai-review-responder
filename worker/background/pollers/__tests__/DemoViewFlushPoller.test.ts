import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1369: DemoViewFlushPoller applies the Redis-drained per-demo view deltas
// to Postgres as one batched UPDATE. The Redis-side math (GETDEL claim,
// never-double-count) is covered by src/lib/demos/__tests__/view-tracking.test.ts;
// this suite covers the poller's own responsibilities — building the batched
// UPDATE correctly, no-op on an empty drain, and not crashing the cycle on a
// failed write.

const { mockSql, mockDrainPendingDemoViews } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockDrainPendingDemoViews: vi.fn(),
}));

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../../src/lib/demos/view-tracking', () => ({
  drainPendingDemoViews: mockDrainPendingDemoViews,
}));

import { runDemoViewFlush } from '../DemoViewFlushPoller';

function fakeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runDemoViewFlush', () => {
  it('does nothing and skips Postgres entirely when nothing is pending', async () => {
    mockDrainPendingDemoViews.mockResolvedValueOnce([]);
    const logger = fakeLogger();

    await runDemoViewFlush(logger);

    expect(mockSql).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('applies the drained deltas as one batched UPDATE via unnest', async () => {
    const lastViewedAt1 = new Date('2026-09-20T00:00:00.000Z');
    const lastViewedAt2 = new Date('2026-09-21T00:00:00.000Z');
    mockDrainPendingDemoViews.mockResolvedValueOnce([
      { demoId: 'demo-1', count: 3, lastViewedAt: lastViewedAt1 },
      { demoId: 'demo-2', count: 1, lastViewedAt: lastViewedAt2 },
    ]);
    mockSql.mockResolvedValueOnce([{ id: 'demo-1' }, { id: 'demo-2' }]);
    const logger = fakeLogger();

    await runDemoViewFlush(logger);

    // ONE statement for the whole batch — never one UPDATE per demo.
    expect(mockSql).toHaveBeenCalledTimes(1);
    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values[0]).toEqual(['demo-1', 'demo-2']); // ids
    expect(values[1]).toEqual([3, 1]); // counts
    // ISO strings, not raw Dates — postgres.js cannot infer `timestamptz[]`
    // from an array of Date objects (see DemoViewFlushPoller.ts).
    expect(values[2]).toEqual([lastViewedAt1.toISOString(), lastViewedAt2.toISOString()]);
    expect(logger.log).toHaveBeenCalledWith('Flushed demo view counters', {
      drained_demos: 2,
      updated_rows: 2,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed UPDATE rather than throwing (crash-window trade-off)', async () => {
    mockDrainPendingDemoViews.mockResolvedValueOnce([
      { demoId: 'demo-1', count: 2, lastViewedAt: new Date() },
    ]);
    mockSql.mockRejectedValueOnce(new Error('connection reset'));
    const logger = fakeLogger();

    await expect(runDemoViewFlush(logger)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatch(/drained increments for this cycle are lost/);
  });

  it('a demo whose Postgres row no longer exists is a silent no-op, not an error', async () => {
    // Row deleted between the GETDEL and this UPDATE (e.g. archival swept the
    // expired demo) — the WHERE clause simply matches zero rows.
    mockDrainPendingDemoViews.mockResolvedValueOnce([
      { demoId: 'demo-gone', count: 1, lastViewedAt: new Date() },
    ]);
    mockSql.mockResolvedValueOnce([]);
    const logger = fakeLogger();

    await runDemoViewFlush(logger);

    expect(logger.log).toHaveBeenCalledWith('Flushed demo view counters', {
      drained_demos: 1,
      updated_rows: 0,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
