import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1369: recordDemoView must be fail-open (never throw, always log via the
// project logger + Sentry) and drainPendingDemoViews must never lose a
// counter it hasn't yet claimed, never double-count one it has.

const {
  mockMultiExec,
  mockMulti,
  mockSmembers,
  mockGetdel,
  mockGet,
  mockSrem,
  mockCaptureException,
} = vi.hoisted(() => {
  const mockMultiExec = vi.fn();
  const chain = {
    incr: vi.fn(function (this: unknown) { return this; }),
    set: vi.fn(function (this: unknown) { return this; }),
    sadd: vi.fn(function (this: unknown) { return this; }),
    exec: mockMultiExec,
  };
  return {
    mockMultiExec,
    mockMulti: vi.fn(() => chain),
    mockSmembers: vi.fn(),
    mockGetdel: vi.fn(),
    mockGet: vi.fn(),
    mockSrem: vi.fn(),
    mockCaptureException: vi.fn(),
  };
});

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    multi: mockMulti,
    smembers: mockSmembers,
    getdel: mockGetdel,
    get: mockGet,
    srem: mockSrem,
  }),
}));

vi.mock('@sentry/node', () => ({
  captureException: mockCaptureException,
}));

import { recordDemoView, drainPendingDemoViews } from '../view-tracking';

beforeEach(() => {
  vi.clearAllMocks();
  mockMultiExec.mockResolvedValue([]);
});

describe('recordDemoView', () => {
  it('queues INCR + last-viewed SET + pending-set SADD in one MULTI/EXEC', async () => {
    await recordDemoView('demo-1');

    const chain = mockMulti.mock.results[0]?.value;
    expect(chain.incr).toHaveBeenCalledWith('demo_view:count:demo-1');
    expect(chain.set).toHaveBeenCalledWith(
      'demo_view:last_viewed:demo-1',
      expect.any(String),
    );
    expect(chain.sadd).toHaveBeenCalledWith('demo_view:pending', 'demo-1');
    expect(mockMultiExec).toHaveBeenCalledTimes(1);
  });

  it('is fail-open: a Redis error never throws and is reported, not silently swallowed', async () => {
    mockMultiExec.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(recordDemoView('demo-1')).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});

describe('drainPendingDemoViews', () => {
  it('returns [] with no Postgres-facing side effect when the pending set is empty', async () => {
    mockSmembers.mockResolvedValueOnce([]);

    const result = await drainPendingDemoViews();

    expect(result).toEqual([]);
    expect(mockGetdel).not.toHaveBeenCalled();
  });

  it('GETDELs each pending demo counter and reads its last-viewed timestamp', async () => {
    mockSmembers.mockResolvedValueOnce(['demo-1', 'demo-2']);
    mockGetdel.mockResolvedValueOnce('3').mockResolvedValueOnce('1');
    const ts1 = Date.now() - 10_000;
    const ts2 = Date.now() - 5_000;
    mockGet.mockResolvedValueOnce(String(ts1)).mockResolvedValueOnce(String(ts2));

    const result = await drainPendingDemoViews();

    expect(result).toEqual([
      { demoId: 'demo-1', count: 3, lastViewedAt: new Date(ts1) },
      { demoId: 'demo-2', count: 1, lastViewedAt: new Date(ts2) },
    ]);
    // Never double-counted: the counter key is claimed via GETDEL exactly
    // once per demo per cycle.
    expect(mockGetdel).toHaveBeenCalledTimes(2);
    expect(mockGetdel).toHaveBeenCalledWith('demo_view:count:demo-1');
    expect(mockGetdel).toHaveBeenCalledWith('demo_view:count:demo-2');
    expect(mockSrem).toHaveBeenCalledWith('demo_view:pending', 'demo-1');
    expect(mockSrem).toHaveBeenCalledWith('demo_view:pending', 'demo-2');
  });

  it('drops a demo whose counter already raced to zero/null without a Postgres delta', async () => {
    mockSmembers.mockResolvedValueOnce(['demo-1']);
    mockGetdel.mockResolvedValueOnce(null);

    const result = await drainPendingDemoViews();

    expect(result).toEqual([]);
    // Still cleaned out of the pending set even with nothing to flush.
    expect(mockSrem).toHaveBeenCalledWith('demo_view:pending', 'demo-1');
    // A count of zero/null never needs a last-viewed read.
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('is idempotent: a second drain over the same (now-cleared) keys returns nothing', async () => {
    mockSmembers.mockResolvedValueOnce(['demo-1']);
    mockGetdel.mockResolvedValueOnce('2');
    mockGet.mockResolvedValueOnce(String(Date.now()));
    const first = await drainPendingDemoViews();
    expect(first).toHaveLength(1);

    // Second cycle: SREM already ran, so a real poller would not even see
    // demo-1 in SMEMBERS again — simulate that directly.
    mockSmembers.mockResolvedValueOnce([]);
    const second = await drainPendingDemoViews();
    expect(second).toEqual([]);
  });

  it('isolates a per-demo Redis failure: one bad key does not blank the whole cycle', async () => {
    mockSmembers.mockResolvedValueOnce(['demo-bad', 'demo-good']);
    mockGetdel
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('5');
    mockGet.mockResolvedValueOnce(String(Date.now()));

    const result = await drainPendingDemoViews();

    expect(result).toEqual([
      expect.objectContaining({ demoId: 'demo-good', count: 5 }),
    ]);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    // The failed demo's pending-set membership is left alone for a later
    // drain to retry — never SREM'd on the error path.
    expect(mockSrem).not.toHaveBeenCalledWith('demo_view:pending', 'demo-bad');
  });

  it('fails open on a broken pending-set read: returns [] and reports, never throws', async () => {
    mockSmembers.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(drainPendingDemoViews()).resolves.toEqual([]);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
