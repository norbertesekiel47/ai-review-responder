import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// LOOP MECHANICS ONLY (#900).
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

// ── #1010 red-team P1-B: the release cycle's alert path ─────────────────────
//
// The ONE addition to "loop mechanics only", and it is still loop mechanics: a
// sink, not a rule. This poller is a guarded poll rather than a BullMQ worker,
// so `attachJobFailureSink` never sees a failure in it and `createGuardedPoll`'s
// shared catch emits `logger.error` alone. This branch routes a NEW terminal
// failure here — `latchSystemHalt`'s `batch_halted` Refusal, reached only from
// `runReleaseCycle` — and a ledger abort that pages nobody leaves the batch
// UN-halted and repeats every minute in silence.
const sentryStub = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@sentry/node', () => sentryStub);

import { resetWorkerConfigForTests } from '@/lib/config/worker';
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
const CYCLE_TIMEOUT_MS = 45_000;

describe('SolicitationReleasePoller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears call history but KEEPS implementations, so the
    // throwing capture the transport-down half of the Sentry case installs would
    // leak into every later one. `mockReset` is the form that drops it.
    sentryStub.captureException.mockReset();
    mockRunReleaseCycle.mockReset();
    mockRunReleaseCycle.mockResolvedValue(emptyReport());
    // `getIntervalMs()` reads the memoized `getWorkerConfig()`; clear the memo so
    // each case's env override (set after this) is parsed fresh (convention #6).
    delete process.env.SOLICITATION_RELEASE_POLL_INTERVAL_MS;
    resetWorkerConfigForTests();
  });

  afterEach(() => {
    // The guard is created at module scope, so its timer outlives a case.
    stopSolicitationReleasePoller();
    vi.useRealTimers();
    delete process.env.SOLICITATION_RELEASE_POLL_INTERVAL_MS;
    resetWorkerConfigForTests();
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

  it('a failing solicitation release cycle raises a Sentry issue and the poller still survives to its next tick', async () => {
    // #1010 red-team P1-B. `latchSystemHalt` runs ONLY from `runReleaseCycle`,
    // driven by this poller, and this branch gives it a way to fail: the
    // `batch_halted` Refusal on the `platform_halt` and `send_window_elapsed`
    // paths. A guarded poll is not a BullMQ worker, so nothing else pages for it.
    vi.useFakeTimers();
    const ledgerError = new Error('refusal ledger rejected the halt write');
    mockRunReleaseCycle.mockRejectedValueOnce(ledgerError);

    startSolicitationReleasePoller();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(1);

    // A real Sentry ISSUE, not a breadcrumb — and the SAME error object, tagged
    // with the subsystem so the lane is identifiable without reading the frame.
    expect(sentryStub.captureException).toHaveBeenCalledTimes(1);
    expect(sentryStub.captureException.mock.calls[0]?.[0]).toBe(ledgerError);
    expect(sentryStub.captureException.mock.calls[0]?.[1]).toMatchObject({
      tags: { subsystem: 'solicitation_release' },
    });

    // The cycle RETHREW, so the guarded-poll harness still owns the durable
    // line. A swallow here would report the failure to Sentry while telling the
    // loop the cycle succeeded, and this assertion is what separates the two.
    expect(loggerCalls.error).toHaveBeenCalledTimes(1);
    expect(loggerCalls.log).not.toHaveBeenCalledWith(
      'Release cycle complete',
      expect.anything(),
    );

    // …and the single-flight flag was released in the harness's `finally`, so
    // the loop lives: a failure that wedged the flag would leave every later
    // tick no-opping at the guard (the #414 shape).
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(2);
    expect(loggerCalls.log).toHaveBeenCalledWith('Release cycle complete', expect.anything());

    // The SECOND half: the capture itself throws. Reporting a failure must never
    // escalate it — an unguarded capture would replace the cycle's real error
    // with the transport's on the way out, so the log line and the issue would
    // disagree about what failed, and this loop would still have to survive it.
    sentryStub.captureException.mockImplementationOnce(() => {
      throw new Error('sentry transport is down');
    });
    const secondAbort = new Error('refusal ledger rejected the halt write again');
    mockRunReleaseCycle.mockRejectedValueOnce(secondAbort);

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(3);
    expect(sentryStub.captureException).toHaveBeenCalledTimes(2);
    // The harness logged the CYCLE's error even though the transport was down,
    // which is only possible if the capture was swallowed and the original
    // rethrown.
    expect(loggerCalls.error).toHaveBeenCalledTimes(2);
    expect(loggerCalls.error.mock.calls[1]?.[1]).toBe(secondAbort);

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    expect(mockRunReleaseCycle).toHaveBeenCalledTimes(4);
  });

  it('honours a configured interval that sits above the cycle deadline', () => {
    vi.useFakeTimers();
    process.env.SOLICITATION_RELEASE_POLL_INTERVAL_MS = '90000';
    resetWorkerConfigForTests();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    startSolicitationReleasePoller();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 90_000);
  });

  it('rejects a configured interval at or below the cycle deadline and uses the default', () => {
    // The one relationship `GuardedPollOptions.timeoutMs` declares must hold is
    // deadline < interval, so a hung cycle frees the single-flight flag BEFORE
    // the next tick. Making the interval env-tunable is the only way an operator
    // could break it, so a value at or below `CYCLE_TIMEOUT_MS` is rejected like
    // any other invalid one rather than silently narrowing that guarantee — the
    // boundary itself (exactly 45s) is the case a `>=` would let through.
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    for (const rejected of [String(CYCLE_TIMEOUT_MS), '30000', '0', '-1000', 'not-a-number', '60s']) {
      process.env.SOLICITATION_RELEASE_POLL_INTERVAL_MS = rejected;
      resetWorkerConfigForTests();

      startSolicitationReleasePoller();

      expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), DEFAULT_INTERVAL_MS);
      stopSolicitationReleasePoller();
    }
  });
});
