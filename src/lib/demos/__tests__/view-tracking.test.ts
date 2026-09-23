import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1369: recordDemoView must be fail-open (never throw, always log via the
// project logger + Sentry) and drainPendingDemoViews must never lose a
// counter it hasn't yet claimed, never double-count one it has.
//
// Both operations go through a single `redis.eval(...)` call (a Lua script),
// never a separate GETDEL/GET/SREM sequence or a MULTI/EXEC pipeline — see
// view-tracking.ts's module doc for why EVAL was chosen over MULTI/EXEC
// (this codebase has no prior evidence `.multi()` is a genuine atomic
// transaction against the Upstash cache instance; EVAL already is, proven by
// `RATE_LIMIT_LUA`/`RELEASE_LOCK_LUA` in production). The "exactly one eval
// call, zero separate getdel/get/srem calls" assertions below are the
// regression guard for that: an earlier (buggy) version of this module did
// GETDEL, then GET, then SREM as three separate round-trips, which left a
// permanent orphaned counter key whenever a page view's own SADD landed
// between the GETDEL and the SREM — that view's count would never be
// tracked in the pending set again unless the SAME demo happened to be
// viewed a second time. These tests would fail under that three-call shape.

const { mockEval, mockSmembers, mockCaptureException } = vi.hoisted(() => ({
  mockEval: vi.fn(),
  mockSmembers: vi.fn(),
  mockCaptureException: vi.fn(),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    eval: mockEval,
    smembers: mockSmembers,
  }),
}));

vi.mock('@sentry/node', () => ({
  captureException: mockCaptureException,
}));

import { recordDemoView, drainPendingDemoViews } from '../view-tracking';

beforeEach(() => {
  vi.clearAllMocks();
  mockEval.mockResolvedValue(1);
});

describe('recordDemoView', () => {
  it('runs INCR + last-viewed SET + pending-set SADD as ONE atomic Lua eval call', async () => {
    await recordDemoView('demo-1');

    expect(mockEval).toHaveBeenCalledTimes(1);
    const [script, numkeys, key1, key2, key3, arg1, arg2] = mockEval.mock.calls[0]!;
    expect(script).toEqual(expect.stringContaining('INCR'));
    expect(script).toEqual(expect.stringContaining('SET'));
    expect(script).toEqual(expect.stringContaining('SADD'));
    expect(numkeys).toBe(3);
    expect(key1).toBe('demo_view:count:demo-1');
    expect(key2).toBe('demo_view:last_viewed:demo-1');
    expect(key3).toBe('demo_view:pending');
    expect(arg1).toEqual(expect.any(String)); // now, epoch ms
    expect(arg2).toBe('demo-1');
  });

  it('is fail-open: a Redis error never throws and is reported, not silently swallowed', async () => {
    mockEval.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(recordDemoView('demo-1')).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});

describe('drainPendingDemoViews', () => {
  it('returns [] with no eval call when the pending set is empty', async () => {
    mockSmembers.mockResolvedValueOnce([]);

    const result = await drainPendingDemoViews();

    expect(result).toEqual([]);
    expect(mockEval).not.toHaveBeenCalled();
  });

  it('claims each pending demo (counter + last-viewed + pending removal) via ONE eval call per demo', async () => {
    mockSmembers.mockResolvedValueOnce(['demo-1', 'demo-2']);
    const ts1 = Date.now() - 10_000;
    const ts2 = Date.now() - 5_000;
    mockEval
      .mockResolvedValueOnce(['3', String(ts1)])
      .mockResolvedValueOnce(['1', String(ts2)]);

    const result = await drainPendingDemoViews();

    expect(result).toEqual([
      { demoId: 'demo-1', count: 3, lastViewedAt: new Date(ts1) },
      { demoId: 'demo-2', count: 1, lastViewedAt: new Date(ts2) },
    ]);
    // Never double-counted, and never a race window: each demo's claim is
    // exactly one atomic Redis command, not a getdel/get/srem sequence.
    expect(mockEval).toHaveBeenCalledTimes(2);
    const [, numkeys1, key1a, key1b, key1c, argDemo1] = mockEval.mock.calls[0]!;
    expect(numkeys1).toBe(3);
    expect(key1a).toBe('demo_view:count:demo-1');
    expect(key1b).toBe('demo_view:last_viewed:demo-1');
    expect(key1c).toBe('demo_view:pending');
    expect(argDemo1).toBe('demo-1');
  });

  it('drops a demo whose counter already raced to zero/null without a Postgres delta', async () => {
    mockSmembers.mockResolvedValueOnce(['demo-1']);
    mockEval.mockResolvedValueOnce([null, null]);

    const result = await drainPendingDemoViews();

    expect(result).toEqual([]);
    // The claim script always runs (it also clears any stray last-viewed key
    // and the pending-set membership) even though nothing gets flushed.
    expect(mockEval).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second drain over the same (now-cleared) keys returns nothing', async () => {
    mockSmembers.mockResolvedValueOnce(['demo-1']);
    mockEval.mockResolvedValueOnce(['2', String(Date.now())]);
    const first = await drainPendingDemoViews();
    expect(first).toHaveLength(1);

    // Second cycle: the claim script's SREM already ran, so a real poller
    // would not even see demo-1 in SMEMBERS again — simulate that directly.
    mockSmembers.mockResolvedValueOnce([]);
    const second = await drainPendingDemoViews();
    expect(second).toEqual([]);
  });

  it('isolates a per-demo Redis failure: one bad key does not blank the whole cycle', async () => {
    mockSmembers.mockResolvedValueOnce(['demo-bad', 'demo-good']);
    mockEval
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(['5', String(Date.now())]);

    const result = await drainPendingDemoViews();

    expect(result).toEqual([
      expect.objectContaining({ demoId: 'demo-good', count: 5 }),
    ]);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    // A failed claim call touched Redis in no way the atomic script did not
    // already roll into one unit — nothing to separately "undo": the failed
    // demo's pending-set membership is retried on the next drain.
  });

  it('fails open on a broken pending-set read: returns [] and reports, never throws', async () => {
    mockSmembers.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(drainPendingDemoViews()).resolves.toEqual([]);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('regression guard: the claim never splits into separate getdel/get/srem calls', async () => {
    // Proves the fix for the orchestrator-flagged race: an earlier version
    // called redis.getdel(count), then redis.get(lastViewed), then
    // redis.srem(pending) as three round-trips. A concurrent recordDemoView
    // landing between the getdel and the srem would INCR a fresh counter and
    // SADD the id back into the pending set (a no-op, since it was still a
    // member at that point) — then the old code's srem would remove it
    // anyway, orphaning that fresh counter outside the pending set until (if
    // ever) the SAME demo was viewed again. Asserting the mocked client's
    // eval is the ONLY method invoked (no getdel/get/srem exist on the mock
    // at all) makes that three-call shape a hard compile+runtime failure,
    // not just an unasserted possibility.
    mockSmembers.mockResolvedValueOnce(['demo-1']);
    mockEval.mockResolvedValueOnce(['1', String(Date.now())]);

    await drainPendingDemoViews();

    // The mocked cache client only exposes `eval` and `smembers` (see the
    // vi.mock above) — if the implementation called `.getdel(`, `.get(` or
    // `.srem(` on the client it would throw "is not a function" here rather
    // than reach this assertion, since those methods do not exist on the
    // mock.
    expect(mockEval).toHaveBeenCalledTimes(1);
  });
});
