import {
  createWorkerLogger,
  logUnhandledPollError,
  toError,
  type WorkerLogger,
} from '../../src/lib/shared/logger';
import { withTimeout } from '../../src/lib/shared/with-timeout';

/**
 * The repeating scaffolding every background loop needs, owned in one place so
 * each poller/scheduler stops re-implementing it. A bare `setInterval(fn, ms)`
 * does not survive two failure modes:
 *
 *   1. Overlap — a cycle slower than the interval running concurrently with the
 *      next tick (double work, racing claims).
 *   2. Wedge — a cycle that hangs forever on a stale pooled connection (where
 *      the server-side `statement_timeout` never fires on a black-hole socket).
 *      Without a client-side deadline the cycle never returns, the single-flight
 *      flag stays set, and EVERY later tick no-ops at the guard — the loop dies
 *      silently (issue #414, root cause #413).
 *
 * `createGuardedPoll` folds the single-flight flag, the per-cycle `withTimeout`
 * deadline, the interval timer, the initial run, error containment, and stop()
 * into one unit. The 4 pre-existing guards keep their bespoke variants (token
 * overlap guard / AbortController / Sentry-cron check-in / env-tunable watchdog)
 * which model behavior this helper intentionally does not.
 */
export interface GuardedPollOptions {
  /**
   * Hard per-cycle deadline. MUST be larger than the cycle's legitimate maximum
   * duration (a too-small value kills healthy cycles) and smaller than the poll
   * interval (so a hung cycle frees the flag before the next tick — recovery
   * then costs one interval, not two).
   */
  timeoutMs: number;
  /**
   * Loop identity, e.g. `'[ArchivalPoller]'`. Used as the `withTimeout` label,
   * the `logUnhandledPollError` prefix, and — when no `logger` is supplied — the
   * `createWorkerLogger` prefix.
   */
  label: string;
  /**
   * Tick spacing. A function is read at `start()` time so loops can resolve an
   * env-tunable interval at runtime (worker env is immutable after boot).
   */
  intervalMs: number | (() => number);
  /** Reuse an existing module logger; defaults to `createWorkerLogger(label)`. */
  logger?: WorkerLogger;
  /**
   * Logged at `.log` when a tick is skipped because the previous cycle is still
   * running. Omit to skip silently (matches loops that never logged the skip).
   */
  onSkipMessage?: string;
  /** Logged at `.error` when a cycle throws or times out. Default `'Poll cycle failed'`. */
  onErrorMessage?: string;
}

export interface GuardedPoll {
  /**
   * The single-flight + deadline-bounded cycle. Never rejects (the loop must not
   * crash on a bad cycle). Safe to invoke directly (tests, manual runs).
   */
  runOnce: () => Promise<void>;
  /**
   * Run the cycle once immediately, then on every `intervalMs` tick. Idempotent:
   * a second `start()` while already running is a no-op and does NOT re-invoke
   * `onStart`. Pass the loop's bespoke "Starting" log as `onStart` — it fires
   * exactly once, only when the timer is actually armed.
   */
  start: (onStart?: () => void) => void;
  /** Clear the interval timer and log "Stopped". Idempotent and safe before start(). */
  stop: () => void;
}

/**
 * Wrap a single poll/scheduler cycle with single-flight, a hard deadline, and
 * the interval timer. Create it once at module scope; the returned `start`/`stop`
 * own the timer lifecycle and `runOnce` owns the guarded cycle.
 *
 * Contract: a timed-out cycle keeps running detached (see `withTimeout`). Cycles
 * that hold a resource across the deadline must tolerate a late settle; the loops
 * using this helper commit per-row/per-tx work (idempotent across ticks) or only
 * read, so a late settle is harmless. The cycle owns its own success logging; the
 * helper owns skip logging, the deadline, error containment, the "Stopped" log,
 * and the flag/timer lifecycle.
 */
export function createGuardedPoll(
  runCycle: (logger: WorkerLogger) => Promise<unknown>,
  options: GuardedPollOptions,
): GuardedPoll {
  const { timeoutMs, label, intervalMs, onSkipMessage, onErrorMessage = 'Poll cycle failed' } = options;
  const resolveLogger = (): WorkerLogger => options.logger ?? createWorkerLogger(label);
  // `timer !== null` (not truthiness): tests mock setInterval to return a falsy
  // handle (e.g. 0), which must still arm idempotency and clear on stop().
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function runOnce(): Promise<void> {
    const logger = resolveLogger();
    if (inFlight) {
      // single-flight: a slow cycle must not overlap the next tick
      if (onSkipMessage) logger.log(onSkipMessage);
      return;
    }
    inFlight = true;
    try {
      await withTimeout(runCycle(logger), timeoutMs, label);
    } catch (err) {
      logger.error(onErrorMessage, toError(err));
    } finally {
      // ALWAYS release — a timed-out cycle must not wedge the flag (the #414 bug).
      inFlight = false;
    }
  }

  function start(onStart?: () => void): void {
    if (timer !== null) return;
    onStart?.();
    void runOnce().catch(logUnhandledPollError(label));
    const ms = typeof intervalMs === 'function' ? intervalMs() : intervalMs;
    timer = setInterval(() => {
      void runOnce().catch(logUnhandledPollError(label));
    }, ms);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
      resolveLogger().log('Stopped');
    }
  }

  return { runOnce, start, stop };
}
