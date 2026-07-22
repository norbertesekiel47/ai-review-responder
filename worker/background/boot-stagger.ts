// worker/background/boot-stagger.ts
//
// Boot-storm hardening for the worker start-up window (ticket #505).
//
// At boot ~24 background loops fire their first cycle, ~30 BullMQ Workers begin
// polling, and ~31 Queues open Redis connections on roughly the same tick. That
// concurrent first-cycle pressure is the leading (still UNPROVEN) candidate for
// leaving a Supavisor backend parked `active/ClientRead` — a socket-level wedge
// no server-side timeout heals. This module SPREADS the DB-backed loops' first
// cycles across a bounded, jittered window instead of firing them all at once,
// which reduces the number of pooler connections opened concurrently in the boot
// window. It is defensible hardening validated EMPIRICALLY by a repro harness —
// NOT a proven-mechanism fix.
//
// Pure core (`computeBootSchedule`) + thin shells (`staggerBoot`,
// `awaitQueueReadiness`, `runBootCoordinator`) so the concurrency/abort logic is
// unit-testable with injected schedulers and signals — the entry point
// (worker/index.ts) only wires real deps (invariant #12).

export interface BootStaggerOptions {
  /** Upper bound on the whole spread — every delay is <= this. */
  totalSpreadMs: number;
  /**
   * Per-gap randomness in [0, 1). 0 → evenly-spaced ramp; higher → more jitter
   * between consecutive first-cycle starts (so they are less likely to land on
   * the same tick). Clamped to [0, 0.9] so a gap can never collapse to 0 (which
   * would break strict monotonicity). Defaults to 0.5.
   */
  jitter?: number;
  /** Injectable [0,1) source so callers/tests stay deterministic. */
  rng?: () => number;
  /**
   * Reports an error thrown SYNCHRONOUSLY by a scheduled start. Best-effort
   * (log-and-swallow): the start's throw is contained so it neither escapes the
   * timer as a fatal `uncaughtException` nor stalls `done` (the failing start
   * still counts toward completion). Omit to swallow silently.
   */
  onStartError?: (error: unknown) => void;
}

const DEFAULT_JITTER = 0.5;
const MAX_JITTER = 0.9;

function clampJitter(jitter: number): number {
  if (!Number.isFinite(jitter) || jitter <= 0) return 0;
  return Math.min(jitter, MAX_JITTER);
}

/**
 * PURE. Returns `count` start delays (ms), each in `[0, totalSpreadMs]`,
 * strictly increasing, with jittered gaps.
 *
 * The first delay is always 0 (nothing gains from delaying the very first
 * loop). Each subsequent delay adds a positive gap of `step * ((1 - j) +
 * j * rng())` where `step = totalSpreadMs / count`. Because every gap lies in
 * `[step*(1-j), step)` with `j <= 0.9`, gaps are strictly positive (monotonic)
 * and their running sum stays below `(count-1) * step < totalSpreadMs` (bounded).
 */
export function computeBootSchedule(
  count: number,
  opts: BootStaggerOptions,
  rng: () => number = opts.rng ?? Math.random,
): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];

  const j = clampJitter(opts.jitter ?? DEFAULT_JITTER);
  const step = opts.totalSpreadMs / count;

  const delays: number[] = [0];
  for (let i = 1; i < count; i++) {
    const gap = step * (1 - j + j * rng());
    delays.push(delays[i - 1]! + gap);
  }
  return delays;
}

type SchedulerFn = (handler: () => void, ms: number) => unknown;

export interface StaggerHandle {
  /** Prevent every un-fired start and resolve `done`. Idempotent. */
  cancel(): void;
  /** Resolves once every scheduled start has fired, OR early on cancel/abort. */
  done: Promise<void>;
}

/**
 * Thin shell: schedule each `starts[i]` at `computeBootSchedule(...)[i]` via the
 * injected `scheduler` (default `setTimeout`). Each start is invoked at most once.
 *
 * Semantics on cancel/abort (chosen and tested): un-fired starts do NOT run, and
 * `done` resolves immediately. A `signal` that is already — or later becomes —
 * aborted is equivalent to calling `cancel()`.
 */
export function staggerBoot(
  starts: Array<() => void>,
  opts: BootStaggerOptions,
  scheduler: SchedulerFn = setTimeout,
  signal?: AbortSignal,
): StaggerHandle {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let settled = false;
  let cancelled = false;
  const handles: unknown[] = [];

  const onAbort = (): void => cancel();

  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (signal) signal.removeEventListener('abort', onAbort);
    resolveDone();
  };

  function cancel(): void {
    if (cancelled) return;
    cancelled = true;
    for (const handle of handles) {
      // Best-effort: real setTimeout handles are cleared so they never fire
      // (and never hold the event loop open during shutdown). Fake/foreign
      // handles are ignored by clearTimeout. The `cancelled` guard below is the
      // actual correctness barrier — a not-yet-cleared timer still no-ops.
      clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    }
    settle();
  }

  if (starts.length === 0 || signal?.aborted) {
    // Nothing to schedule (or already aborted) — resolve immediately.
    if (signal?.aborted) cancelled = true;
    settle();
    return { cancel, done };
  }

  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const schedule = computeBootSchedule(starts.length, opts, opts.rng);
  let fired = 0;

  starts.forEach((start, i) => {
    const handle = scheduler(() => {
      if (cancelled) return;
      try {
        start();
      } catch (error) {
        // Contain a synchronous throw: it must not escape the timer as a fatal
        // uncaughtException (crash-net kills all loops+workers) nor stall `done`.
        // The failing start still counts toward completion below.
        opts.onStartError?.(error);
      }
      fired += 1;
      if (fired === starts.length) settle();
    }, schedule[i]!);
    handles.push(handle);
  });

  return { cancel, done };
}

export type ReadinessOutcome = 'ready' | 'timeout' | 'aborted';

interface ReadinessTimers {
  set: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_READINESS_TIMERS: ReadinessTimers = { set: setTimeout, clear: clearTimeout };

/**
 * Wait — bounded and abortable — until the queue Redis connection is ready.
 *
 * FAIL-OPEN by design (production.md: no infinite waits): the timeout resolves
 * `'timeout'` and a `waitUntilReady()` rejection resolves `'ready'`, so boot
 * never hangs on Redis. The system is already spend-safe (the cost reservation
 * precedes every LLM call), so proceeding on an unconfirmed connection is safe;
 * BullMQ's own reconnect handles a still-connecting client. Only an abort (SIGTERM
 * mid-boot) resolves `'aborted'`, telling the coordinator to stop. Always disposes
 * the timer and the abort listener on settle.
 */
export function awaitQueueReadiness(
  waitUntilReady: () => Promise<unknown>,
  opts: { timeoutMs: number },
  signal?: AbortSignal,
  timers: ReadinessTimers = DEFAULT_READINESS_TIMERS,
): Promise<ReadinessOutcome> {
  if (signal?.aborted) return Promise.resolve('aborted');

  return new Promise<ReadinessOutcome>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;

    const onAbort = (): void => finish('aborted');
    const cleanup = (): void => {
      timers.clear(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (outcome: ReadinessOutcome): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(outcome);
    };

    timer = timers.set(() => finish('timeout'), opts.timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    waitUntilReady().then(
      () => finish('ready'),
      () => finish('ready'), // fail-open: a connect error must not hang boot
    );
  });
}

export interface BootCoordinatorDeps {
  /** Bounded, abortable readiness wait — returns its outcome, never rejects. */
  awaitReadiness: (signal: AbortSignal) => Promise<ReadinessOutcome>;
  /** The DB-backed loop `startX()` calls, wrapped as thunks, to spread out. */
  starts: Array<() => void>;
  staggerOptions: BootStaggerOptions;
  /** Resume the autorun-deferred BullMQ workers. Called at most once, last. */
  resumeWorkers: () => void;
  /** The ONE boot signal — abort at any stage stops all further work. */
  signal: AbortSignal;
  scheduler?: SchedulerFn;
  log?: (message: string) => void;
}

/**
 * The boot-readiness sequence: await Redis/BullMQ readiness → stagger the
 * DB-backed first cycles → resume the workers. The single `signal` spans the
 * whole sequence: an abort at any stage fires no further start and never resumes
 * the workers (so a pending continuation can't begin DB work mid-SIGTERM).
 */
export async function runBootCoordinator(deps: BootCoordinatorDeps): Promise<void> {
  const { awaitReadiness, starts, staggerOptions, resumeWorkers, signal, scheduler, log } = deps;

  if (signal.aborted) {
    log?.('[boot] aborted before readiness — nothing started');
    return;
  }

  // Tracks whether staggerBoot was reached: past that point every start() has
  // either fired or been contained by onStartError, so the failure recovery
  // below must not re-fire starts (loops are not guaranteed re-entrant).
  let staggerBegan = false;
  try {
    const outcome = await awaitReadiness(signal);
    if (signal.aborted || outcome === 'aborted') {
      log?.('[boot] aborted during readiness wait — nothing started');
      return;
    }
    if (outcome === 'timeout') {
      log?.('[boot] queue readiness not confirmed within timeout — proceeding (system is spend-safe)');
    }

    staggerBegan = true;
    const { done } = staggerBoot(starts, staggerOptions, scheduler, signal);
    await done;

    if (signal.aborted) {
      log?.('[boot] aborted during staggered start — not resuming workers');
      return;
    }

    resumeWorkers();
    log?.('[boot] readiness cure complete — background loops staggered, workers resumed');
  } catch (err) {
    // An unexpected coordinator failure must NEVER leave a zombie worker (up
    // and listening but draining zero jobs, with no loops and therefore no
    // paging). Deliberate aborts return above; anything else fails OPEN via
    // failOpenAfterBootFailure, then rethrows so the caller still logs the
    // root failure.
    if (signal.aborted) {
      log?.('[boot] aborted during coordinator failure — not resuming workers');
      throw err;
    }
    failOpenAfterBootFailure({ starts, staggerOptions, resumeWorkers, staggerBegan, log });
    throw err;
  }
}

/**
 * F2 recovery: degrade to the legacy synchronous boot. Fires the starts only
 * if the stagger never began (past that point per-start errors were already
 * contained by onStartError, and loops are not guaranteed re-entrant), then
 * always resumes the autorun-deferred BullMQ workers.
 */
function failOpenAfterBootFailure(args: {
  starts: Array<() => void>;
  staggerOptions: BootStaggerOptions;
  resumeWorkers: () => void;
  staggerBegan: boolean;
  log?: (message: string) => void;
}): void {
  args.log?.('[boot] coordinator failed — failing OPEN to synchronous start so the worker cannot zombie');
  if (!args.staggerBegan) {
    for (const start of args.starts) {
      try {
        start();
      } catch (startErr) {
        args.staggerOptions.onStartError?.(startErr);
      }
    }
  }
  args.resumeWorkers();
}

/**
 * The `BOOT_STAGGER_ENABLED` toggle. Default = cure ON (staging/prod get the
 * hardening automatically). Only the exact literal `"false"` turns it off, for a
 * baseline repro run (T1 harness). Unset/empty/anything-else → ON.
 */
export function isBootStaggerEnabled(raw: string | undefined): boolean {
  return raw !== 'false';
}
