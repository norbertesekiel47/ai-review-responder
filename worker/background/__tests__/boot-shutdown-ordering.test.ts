import { describe, it, expect, vi } from 'vitest';

import { createGracefulShutdown, type GracefulShutdownDeps } from '../../shutdown';

// #505: the boot-readiness coordinator must be aborted BEFORE the background
// loops are stopped, so a pending staggered loop-start or worker-resume can
// never begin DB work mid-SIGTERM. This lives with the boot-stagger unit tests
// because it verifies that boot-coordinator teardown contract specifically.
function makeDeps(order: string[], overrides: Partial<GracefulShutdownDeps> = {}): GracefulShutdownDeps {
  const record = (label: string) => async () => {
    order.push(label);
  };
  return {
    graceMs: 25_000,
    isFatalExitInProgress: () => false,
    abortBootCoordinator: vi.fn(() => order.push('abortBootCoordinator')),
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
    armWatchdog: vi.fn(() => vi.fn()),
    log: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

describe('graceful shutdown — boot coordinator ordering (#505)', () => {
  it('aborts the boot coordinator BEFORE stopping the background loops', async () => {
    const order: string[] = [];
    const deps = makeDeps(order);

    await createGracefulShutdown(deps)();

    expect(deps.abortBootCoordinator).toHaveBeenCalledTimes(1);
    expect(order.indexOf('abortBootCoordinator')).toBeLessThan(order.indexOf('stopBackgroundLoops'));
    // And it precedes every awaitable teardown step too.
    expect(order.indexOf('abortBootCoordinator')).toBeLessThan(order.indexOf('closeWorkers'));
  });

  it('a throwing abort does not abort the rest of the teardown (best-effort)', async () => {
    const order: string[] = [];
    const deps = makeDeps(order, {
      abortBootCoordinator: vi.fn(() => {
        order.push('abortBootCoordinator');
        throw new Error('abort blew up');
      }),
    });

    await createGracefulShutdown(deps)();

    expect(order).toContain('stopBackgroundLoops');
    expect(order).toContain('closeDb');
    expect(deps.logError).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});
