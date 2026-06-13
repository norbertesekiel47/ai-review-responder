import { describe, it, expect, vi } from 'vitest';
import { createGracefulShutdown, type GracefulShutdownDeps } from '../shutdown';

// Build deps whose async steps push their label into a shared order log, so the
// flush-before-close ordering (§5.4) is assertable. armWatchdog captures its
// callback + ms and returns a cancel spy; exit is a spy (never really exits).
function makeDeps(overrides: Partial<GracefulShutdownDeps> = {}) {
  const order: string[] = [];
  const record = (label: string) => async () => {
    order.push(label);
  };
  const cancelWatchdog = vi.fn();
  let watchdogCallback: (() => void) | undefined;
  let watchdogMs: number | undefined;

  const deps: GracefulShutdownDeps = {
    graceMs: 25_000,
    isFatalExitInProgress: () => false,
    stopBackgroundLoops: vi.fn(() => order.push('stopBackgroundLoops')),
    drainAnalyticsDispatch: record('drainAnalyticsDispatch'),
    flushAnalytics: record('flushAnalytics'),
    flushSentry: record('flushSentry'),
    closeWorkers: record('closeWorkers'),
    closeQueues: record('closeQueues'),
    closeServer: record('closeServer'),
    shutdownAnalytics: record('shutdownAnalytics'),
    closeDb: record('closeDb'),
    exit: vi.fn(),
    armWatchdog: vi.fn((onTimeout: () => void, ms: number) => {
      watchdogCallback = onTimeout;
      watchdogMs = ms;
      return cancelWatchdog;
    }),
    log: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };

  return {
    deps,
    order,
    cancelWatchdog,
    getWatchdogCallback: () => watchdogCallback,
    getWatchdogMs: () => watchdogMs,
  };
}

describe('createGracefulShutdown', () => {
  it('flushes analytics + Sentry BEFORE the blocking worker close, and shutdownAnalytics after', async () => {
    const { deps, order } = makeDeps();
    await createGracefulShutdown(deps)();

    const idx = (label: string) => order.indexOf(label);
    // Flush-before-close (§5.4): both flushes precede closeWorkers, so a hung
    // worker close can't strand their buffers before the watchdog force-exits.
    expect(idx('flushAnalytics')).toBeLessThan(idx('closeWorkers'));
    expect(idx('flushSentry')).toBeLessThan(idx('closeWorkers'));
    // Terminal analytics shutdown happens AFTER the workers drain, so jobs
    // finishing during a clean close still get their events captured.
    expect(idx('shutdownAnalytics')).toBeGreaterThan(idx('closeWorkers'));
    // Analytics dispatch is drained before the DB pool closes; DB closes last.
    expect(idx('drainAnalyticsDispatch')).toBeLessThan(idx('closeDb'));
    expect(idx('closeDb')).toBe(order.length - 1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('is a no-op on a second signal (re-entrancy guard)', async () => {
    const { deps, order } = makeDeps();
    const shutdown = createGracefulShutdown(deps);

    await shutdown();
    const firstRunLength = order.length;
    await shutdown();

    expect(order.length).toBe(firstRunLength);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('bails when a fatal exit is already in progress', async () => {
    const { deps, order } = makeDeps({ isFatalExitInProgress: () => true });
    await createGracefulShutdown(deps)();

    expect(order).toEqual([]);
    expect(deps.armWatchdog).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it('arms the watchdog with graceMs and force-exits(1) if it fires', async () => {
    const { deps, getWatchdogCallback, getWatchdogMs } = makeDeps();
    await createGracefulShutdown(deps)();

    expect(deps.armWatchdog).toHaveBeenCalledTimes(1);
    expect(getWatchdogMs()).toBe(25_000);

    // Simulate the watchdog firing (e.g. a wedged closeWorkers) → force exit(1).
    getWatchdogCallback()?.();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('cancels the watchdog on clean completion', async () => {
    const { deps, cancelWatchdog } = makeDeps();
    await createGracefulShutdown(deps)();
    expect(cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it('is best-effort: a failing step does not abort the remaining teardown', async () => {
    const { deps, order } = makeDeps({
      closeWorkers: vi.fn().mockRejectedValue(new Error('worker close blew up')),
    });
    await createGracefulShutdown(deps)();

    // closeWorkers threw, but later steps still ran and the process still exits 0.
    expect(order).toContain('closeQueues');
    expect(order).toContain('shutdownAnalytics');
    expect(order).toContain('closeDb');
    expect(deps.logError).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});
