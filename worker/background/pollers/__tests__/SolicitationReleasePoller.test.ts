import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// LOOP MECHANICS ONLY (#900 task 0, the eval task).
//
// `SolicitationReleasePoller.ts` is a deliberately SHALLOW composition root: it
// owns the `sql` singleton, the interval and the `createGuardedPoll`
// scaffolding, and no rules. Everything a domain assertion could be about — the
// phase order, the governor order, the Judge split, the per-tick budget — lives
// in `src/lib/solicitation/release.ts` and is covered by
// `release.integration.test.ts`. Asserting any of it here would duplicate that
// coverage against a mock and let the poller quietly grow a rule.
//
// So `runReleaseCycle` is mocked to a bare counter, and what is left is exactly
// the four things this file is responsible for: it hands over the singleton,
// `start` fires immediately and then on the interval, `stop` clears the timer,
// and a slow cycle does not overlap the next tick.
//
// These need no `.fails` marker: the poller and its exports already exist, so
// every case below is green from this commit.

const { mockSql, mockRunReleaseCycle, loggerCalls } = vi.hoisted(() => ({
  // A sentinel, not a mock database: the only claim under test is that THIS
  // object is what reaches the domain module. A poller that resolved its own
  // client would fail here and nowhere else.
  mockSql: { __brand: 'sql-singleton' } as unknown,
  mockRunReleaseCycle: vi.fn(),
  loggerCalls: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

vi.mock('@/lib/solicitation/release', () => ({
  runReleaseCycle: mockRunReleaseCycle,
  RELEASE_PER_TICK_BUDGET: 2,
  RELEASE_SCAN_LIMIT: 50,
}));

vi.mock('@/lib/shared/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/logger')>();
  return { ...actual, createWorkerLogger: () => loggerCalls };
});

import {
  runSolicitationReleaseCycle,
  startSolicitationReleasePoller,
  stopSolicitationReleasePoller,
} from '../SolicitationReleasePoller';

/** The shape `runReleaseCycle` resolves to; every count is zero here. */
function emptyReport() {
  return {
    released: 0,
    releasePhaseStoppedBy: null,
    withheldByReason: {},
    downgraded: 0,
    heldForJudge: 0,
    sendWindowElapsed: 0,
    batchExpired: 0,
    unknownTerminalized: 0,
    backstopClosed: 0,
  };
}

const DEFAULT_INTERVAL_MS = 60_000;

describe('SolicitationReleasePoller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunReleaseCycle.mockResolvedValue(emptyReport());
  });

  afterEach(() => {
    // The guard is created at module scope, so its timer outlives a case.
    stopSolicitationReleasePoller();
    vi.useRealTimers();
  });

  it('hands the sql singleton to runReleaseCycle', async () => {
    await runSolicitationReleaseCycle(mockSql as never);

    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(1);
    expect(mockRunReleaseCycle).toHaveBeenCalledWith(mockSql);
  });

  it('start runs one cycle immediately and then one per interval', async () => {
    vi.useFakeTimers();

    startSolicitationReleasePoller();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(1);
    // The singleton, resolved by the poller rather than by the caller.
    expect(mockRunReleaseCycle).toHaveBeenLastCalledWith(mockSql);

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(3);
  });

  it('start is idempotent while the timer is already armed', async () => {
    vi.useFakeTimers();

    startSolicitationReleasePoller();
    startSolicitationReleasePoller();
    await vi.advanceTimersByTimeAsync(0);

    // A second start must not arm a second timer — two interleaved timers would
    // double every tick's work on a loop whose whole job is to pace sends.
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(2);
  });

  it('stop clears the interval so no further cycle runs', async () => {
    vi.useFakeTimers();

    startSolicitationReleasePoller();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(1);

    stopSolicitationReleasePoller();
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS * 3);

    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(1);
    // Idempotent and safe to call again — `worker/index.ts` calls it on the
    // shutdown path, which can run after a failed boot.
    expect(() => stopSolicitationReleasePoller()).not.toThrow();
  });

  it('skips a second immediate run while the previous cycle is still in flight', async () => {
    // Overlapping cycles would race two releasers over the same candidate rows,
    // and amendment B3's cap resolution rests on this loop being serialized by
    // construction on the single-replica worker.
    //
    // The overlap is reached through a stop/start rather than through the timer,
    // and that is forced by the loop's own numbers: `CYCLE_TIMEOUT_MS` (45s) is
    // deliberately BELOW `DEFAULT_INTERVAL_MS` (60s), so a hung cycle always
    // frees the flag one deadline before the next tick — an interval tick can
    // never land on an in-flight cycle. `start()` runs one cycle immediately,
    // so a restart mid-cycle is the reachable overlap.
    vi.useFakeTimers();
    let releaseCycle!: () => void;
    const inFlight = new Promise<ReturnType<typeof emptyReport>>((resolve) => {
      releaseCycle = () => resolve(emptyReport());
    });
    mockRunReleaseCycle.mockReturnValueOnce(inFlight);

    startSolicitationReleasePoller();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(1);

    stopSolicitationReleasePoller();
    startSolicitationReleasePoller();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(1);

    releaseCycle();
    await inFlight;
    await vi.advanceTimersByTimeAsync(0);

    // The flag is released once the cycle settles, so the next tick runs again.
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(2);
  });

  it('frees the single-flight flag when a cycle outruns its deadline', async () => {
    // Issue #414: without a client-side deadline a cycle wedged on a stale
    // pooled connection never returns, the flag stays set, and EVERY later tick
    // no-ops at the guard — the loop dies silently. `CYCLE_TIMEOUT_MS` is 45s,
    // below the 60s interval, so recovery costs one interval rather than two.
    vi.useFakeTimers();
    const neverSettles = new Promise<ReturnType<typeof emptyReport>>(() => {});
    mockRunReleaseCycle.mockReturnValueOnce(neverSettles);

    startSolicitationReleasePoller();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(1);

    // The deadline fires before the next tick, and the guard contains the error
    // rather than letting it crash the loop.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(loggerCalls.error).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS - 45_000);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(2);
  });
});
