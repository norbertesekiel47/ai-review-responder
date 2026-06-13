// Graceful-shutdown orchestrator (deep-scan §5.4).
//
// Extracted from worker/index.ts so the re-entrancy guard, watchdog, and
// flush-before-close ordering can be unit-tested with injected fakes (the entry
// point only wires real dependencies — invariant #12). Side-effect-free on
// import: it constructs no clients and touches no process state until the
// returned handler is invoked by a SIGTERM/SIGINT.
//
// Design decisions encoded here:
//   1. Re-entrancy: a second signal is a no-op. The handler also bails if the
//      last-resort fatal-exit crash net (§2.7) is already taking the process
//      down — a crash owns the exit; never start graceful teardown on top of it.
//   2. Watchdog: armed FIRST, before any awaitable step. If a worker is mid-flight
//      on a hung outbound call (§5.1), `closeWorkers()` can block forever; the
//      watchdog force-exits within the Railway grace window so we never wait for
//      SIGKILL (which would lose the analytics/Sentry flush).
//   3. Flush BEFORE the blocking close: analytics + Sentry are flushed before
//      `closeWorkers()` so a hang can't strand their buffers. `flushAnalytics()`
//      keeps the client alive, so the post-close `shutdownAnalytics()` still
//      captures events emitted by jobs draining during a CLEAN close.
//   4. Every step is best-effort (log-and-swallow): one failing teardown step
//      must not abort the rest, and the watchdog is the ultimate backstop.

export interface GracefulShutdownDeps {
  /** Force-exit deadline (ms) — sized inside the platform's SIGTERM→SIGKILL window. */
  graceMs: number;
  /** True when the §2.7 fatal-exit net is already bringing the process down. */
  isFatalExitInProgress: () => boolean;
  /** Stop all background pollers/schedulers (synchronous clearInterval calls). */
  stopBackgroundLoops: () => void;
  /** Drain the DB-backed analytics dispatch — MUST finish before closeDb(). */
  drainAnalyticsDispatch: () => Promise<void>;
  /** Flush the in-memory analytics buffer WITHOUT closing the client. */
  flushAnalytics: () => Promise<void>;
  /** Flush Sentry's buffered events (bounded). */
  flushSentry: () => Promise<void>;
  /** Close every BullMQ worker — the potentially-blocking step. */
  closeWorkers: () => Promise<void>;
  /** Close every queue. */
  closeQueues: () => Promise<void>;
  /** Close the Fastify server. */
  closeServer: () => Promise<void>;
  /** Final analytics flush + client shutdown (terminal). */
  shutdownAnalytics: () => Promise<void>;
  /** Close the Postgres pool. */
  closeDb: () => Promise<void>;
  /** Terminate the process. */
  exit: (code: number) => void;
  /** Arm the watchdog; returns a cancel function. Implementations should unref(). */
  armWatchdog: (onTimeout: () => void, ms: number) => () => void;
  log: (message: string) => void;
  logError: (message: string, err: unknown) => void;
}

/**
 * Build the SIGTERM/SIGINT handler. The returned function is idempotent across
 * repeated signals (see decision #1). The `isShuttingDown` flag lives in the
 * closure so it persists across both signal registrations.
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps): () => Promise<void> {
  let isShuttingDown = false;

  async function runStep(label: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (err) {
      deps.logError(`Graceful shutdown step failed: ${label}`, err);
    }
  }

  return async function shutdown(): Promise<void> {
    if (isShuttingDown || deps.isFatalExitInProgress()) return;
    isShuttingDown = true;
    deps.log('Shutting down worker...');

    const cancelWatchdog = deps.armWatchdog(() => {
      deps.logError('Graceful shutdown exceeded grace window — forcing exit', undefined);
      deps.exit(1);
    }, deps.graceMs);

    try {
      deps.stopBackgroundLoops();
    } catch (err) {
      deps.logError('Graceful shutdown step failed: stop background loops', err);
    }

    await runStep('analytics-dispatch drain', deps.drainAnalyticsDispatch);

    // Flush BEFORE the potentially-blocking worker close (§5.4 decision #3).
    await runStep('analytics flush', deps.flushAnalytics);
    await runStep('sentry flush', deps.flushSentry);

    await runStep('workers close', deps.closeWorkers);
    await runStep('queues close', deps.closeQueues);
    await runStep('server close', deps.closeServer);

    // Final flush + close now that no further events can be emitted.
    await runStep('analytics shutdown', deps.shutdownAnalytics);
    await runStep('db close', deps.closeDb);

    cancelWatchdog();
    deps.exit(0);
  };
}
