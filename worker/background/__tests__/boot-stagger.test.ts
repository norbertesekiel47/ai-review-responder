import { describe, it, expect, vi } from 'vitest';

import {
  computeBootSchedule,
  staggerBoot,
  awaitQueueReadiness,
  runBootCoordinator,
  isBootStaggerEnabled,
  type BootStaggerOptions,
} from '../boot-stagger';

// Deterministic rng cycling through a fixed list — never Math.random (some
// sandboxes disallow it, and tests must be reproducible).
function seededRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('computeBootSchedule', () => {
  const opts: BootStaggerOptions = { totalSpreadMs: 10_000, jitter: 0.5 };

  it('returns [] for count 0 and [0] for count 1', () => {
    expect(computeBootSchedule(0, opts, seededRng([0.5]))).toEqual([]);
    expect(computeBootSchedule(1, opts, seededRng([0.5]))).toEqual([0]);
    expect(computeBootSchedule(-3, opts, seededRng([0.5]))).toEqual([]);
  });

  it('length === count', () => {
    for (const count of [2, 5, 24, 30]) {
      expect(computeBootSchedule(count, opts, seededRng([0.1, 0.9, 0.5, 0.3])).length).toBe(count);
    }
  });

  it('every delay is bounded by totalSpreadMs and the first is 0', () => {
    const schedule = computeBootSchedule(24, opts, seededRng([0.1, 0.9, 0.5, 0.3, 0.7]));
    expect(schedule[0]).toBe(0);
    for (const delay of schedule) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(opts.totalSpreadMs);
    }
  });

  it('is strictly monotonic for any rng sequence (property)', () => {
    // Sweep many rng patterns incl. the pathological all-zero and all-one.
    const patterns: number[][] = [
      [0],
      [0.999999],
      [0, 1, 0, 1],
      [0.5],
      [0.01, 0.02, 0.03],
      [0.9, 0.1, 0.5, 0.2, 0.8],
    ];
    for (const pattern of patterns) {
      for (const count of [2, 3, 10, 24, 31]) {
        const schedule = computeBootSchedule(count, { totalSpreadMs: 8_000, jitter: 0.9 }, seededRng(pattern));
        for (let i = 1; i < schedule.length; i++) {
          expect(schedule[i]!).toBeGreaterThan(schedule[i - 1]!);
        }
        expect(schedule[schedule.length - 1]!).toBeLessThanOrEqual(8_000);
      }
    }
  });

  it('jitter 0 yields an evenly-spaced ramp', () => {
    const schedule = computeBootSchedule(5, { totalSpreadMs: 10_000, jitter: 0 }, seededRng([0.5]));
    // step = 10000/5 = 2000; gaps all == step
    expect(schedule).toEqual([0, 2000, 4000, 6000, 8000]);
  });
});

// A fake scheduler that records scheduled callbacks and fires them on demand,
// so no real timers run. Mirrors the guarded-poll test style.
function makeFakeScheduler() {
  const scheduled: Array<{ fn: () => void; ms: number; fired: boolean }> = [];
  const scheduler = (fn: () => void, ms: number) => {
    const entry = { fn, ms, fired: false };
    scheduled.push(entry);
    return scheduled.length - 1; // fake handle
  };
  const fireAll = () => {
    for (const entry of scheduled) {
      if (!entry.fired) {
        entry.fired = true;
        entry.fn();
      }
    }
  };
  const fireIndex = (i: number) => {
    const entry = scheduled[i]!;
    if (!entry.fired) {
      entry.fired = true;
      entry.fn();
    }
  };
  return { scheduler, scheduled, fireAll, fireIndex };
}

describe('staggerBoot', () => {
  const opts: BootStaggerOptions = { totalSpreadMs: 10_000, jitter: 0, rng: () => 0.5 };

  it('schedules each start at its computed delay and invokes each exactly once', async () => {
    const calls: number[] = [];
    const starts = [0, 1, 2].map((i) => () => calls.push(i));
    const fake = makeFakeScheduler();

    const { done } = staggerBoot(starts, opts, fake.scheduler);

    // Nothing fires before the scheduler releases.
    expect(calls).toEqual([]);
    expect(fake.scheduled.map((s) => s.ms)).toEqual(computeBootSchedule(3, opts, () => 0.5));

    fake.fireAll();
    await done;

    expect(calls).toEqual([0, 1, 2]);
    // Firing again (defensive) does not re-invoke — timers are one-shot.
    fake.fireAll();
    expect(calls).toEqual([0, 1, 2]);
  });

  it('resolves done immediately when there are no starts', async () => {
    const fake = makeFakeScheduler();
    const { done } = staggerBoot([], opts, fake.scheduler);
    await expect(done).resolves.toBeUndefined();
    expect(fake.scheduled).toEqual([]);
  });

  it('cancel() before a timer fires prevents that start AND resolves done', async () => {
    const calls: number[] = [];
    const starts = [0, 1, 2].map((i) => () => calls.push(i));
    const fake = makeFakeScheduler();

    const { done, cancel } = staggerBoot(starts, opts, fake.scheduler);
    fake.fireIndex(0); // first start runs
    cancel(); // cancel the rest
    fake.fireAll(); // the remaining callbacks are now no-ops

    await expect(done).resolves.toBeUndefined();
    expect(calls).toEqual([0]);
  });

  it('an already-aborted signal behaves as cancel: nothing schedules or runs', async () => {
    const calls: number[] = [];
    const starts = [0, 1].map((i) => () => calls.push(i));
    const fake = makeFakeScheduler();
    const controller = new AbortController();
    controller.abort();

    const { done } = staggerBoot(starts, opts, fake.scheduler, controller.signal);
    fake.fireAll();

    await expect(done).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(fake.scheduled).toEqual([]);
  });

  it('aborting the signal mid-flight == cancel: un-fired starts do not run', async () => {
    const calls: number[] = [];
    const starts = [0, 1, 2].map((i) => () => calls.push(i));
    const fake = makeFakeScheduler();
    const controller = new AbortController();

    const { done } = staggerBoot(starts, opts, fake.scheduler, controller.signal);
    fake.fireIndex(0);
    controller.abort();
    fake.fireAll();

    await expect(done).resolves.toBeUndefined();
    expect(calls).toEqual([0]);
  });

  it('a start that throws synchronously is contained: other starts run and done still resolves (FIX F2)', async () => {
    const calls: number[] = [];
    const onStartError = vi.fn();
    const starts = [
      () => calls.push(0),
      () => {
        throw new Error('start 1 blew up');
      },
      () => calls.push(2),
    ];
    const fake = makeFakeScheduler();

    const { done } = staggerBoot(starts, { ...opts, onStartError }, fake.scheduler);
    fake.fireAll();

    // done resolves even though the middle start threw...
    await expect(done).resolves.toBeUndefined();
    // ...and the surrounding starts still ran.
    expect(calls).toEqual([0, 2]);
    // The throw is reported, not re-thrown out of the timer.
    expect(onStartError).toHaveBeenCalledTimes(1);
    expect(onStartError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe('awaitQueueReadiness', () => {
  function fakeTimers() {
    const clear = vi.fn();
    const set = vi.fn(() => 42 as unknown as ReturnType<typeof setTimeout>);
    return { set, clear };
  }

  it('resolves "ready" when waitUntilReady resolves, clearing the timer', async () => {
    const timers = fakeTimers();
    const outcome = await awaitQueueReadiness(() => Promise.resolve('ok'), { timeoutMs: 5_000 }, undefined, timers);
    expect(outcome).toBe('ready');
    expect(timers.clear).toHaveBeenCalledTimes(1);
  });

  it('resolves "timeout" (fail-open) when the timer fires first', async () => {
    let fireTimer!: () => void;
    const timers = {
      clear: vi.fn(),
      set: vi.fn((fn: () => void) => {
        fireTimer = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
    };
    // waitUntilReady never settles.
    const promise = awaitQueueReadiness(() => new Promise<void>(() => {}), { timeoutMs: 5_000 }, undefined, timers);
    fireTimer();
    await expect(promise).resolves.toBe('timeout');
  });

  it('resolves "ready" (fail-open) even when waitUntilReady rejects', async () => {
    const timers = fakeTimers();
    const outcome = await awaitQueueReadiness(() => Promise.reject(new Error('redis down')), { timeoutMs: 5_000 }, undefined, timers);
    expect(outcome).toBe('ready');
    expect(timers.clear).toHaveBeenCalled();
  });

  it('returns "aborted" immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const timers = fakeTimers();
    const outcome = await awaitQueueReadiness(() => new Promise<void>(() => {}), { timeoutMs: 5_000 }, controller.signal, timers);
    expect(outcome).toBe('aborted');
  });

  it('aborting mid-wait resolves "aborted" and disposes the abort listener + timer', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const timers = fakeTimers();

    const promise = awaitQueueReadiness(() => new Promise<void>(() => {}), { timeoutMs: 5_000 }, controller.signal, timers);
    controller.abort();

    await expect(promise).resolves.toBe('aborted');
    expect(timers.clear).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('runBootCoordinator', () => {
  const staggerOptions: BootStaggerOptions = { totalSpreadMs: 10_000, jitter: 0, rng: () => 0.5 };

  it('awaits readiness, staggers the starts, THEN resumes workers', async () => {
    const order: string[] = [];
    const fake = makeFakeScheduler();
    const starts = [0, 1].map((i) => () => order.push(`start${i}`));
    const resumeWorkers = vi.fn(() => order.push('resume'));
    const controller = new AbortController();

    const run = runBootCoordinator({
      awaitReadiness: async () => {
        order.push('readiness');
        return 'ready';
      },
      starts,
      staggerOptions,
      resumeWorkers,
      signal: controller.signal,
      scheduler: fake.scheduler,
    });

    // Let the readiness await settle, then release the staggered timers.
    await Promise.resolve();
    await Promise.resolve();
    fake.fireAll();
    await run;

    expect(order).toEqual(['readiness', 'start0', 'start1', 'resume']);
    expect(resumeWorkers).toHaveBeenCalledTimes(1);
  });

  // FIX F1 (listen-window race): the module-scope AbortController means a SIGTERM
  // during app.listen() aborts the SAME signal the coordinator later observes. An
  // already-aborted signal must make the coordinator bail at its first line —
  // readiness is never awaited, nothing is scheduled, and workers are NOT resumed.
  it('signal already aborted before coordinator starts: no readiness, no start, no worker-resume (FIX F1)', async () => {
    const fake = makeFakeScheduler();
    const starts = [vi.fn(), vi.fn()];
    const resumeWorkers = vi.fn();
    const controller = new AbortController();
    controller.abort();

    const awaitReadiness = vi.fn(async () => 'ready' as const);
    await runBootCoordinator({
      awaitReadiness,
      starts,
      staggerOptions,
      resumeWorkers,
      signal: controller.signal,
      scheduler: fake.scheduler,
    });

    expect(awaitReadiness).not.toHaveBeenCalled();
    expect(starts[0]).not.toHaveBeenCalled();
    expect(resumeWorkers).not.toHaveBeenCalled();
    expect(fake.scheduled).toEqual([]);
  });

  it('abort DURING readiness fires no start and no worker-resume', async () => {
    const fake = makeFakeScheduler();
    const starts = [vi.fn(), vi.fn()];
    const resumeWorkers = vi.fn();
    const controller = new AbortController();

    // awaitReadiness observes the abort and returns 'aborted'.
    const awaitReadiness = (signal: AbortSignal): Promise<'aborted'> =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });

    const run = runBootCoordinator({
      awaitReadiness,
      starts,
      staggerOptions,
      resumeWorkers,
      signal: controller.signal,
      scheduler: fake.scheduler,
    });

    controller.abort();
    await run;

    expect(starts[0]).not.toHaveBeenCalled();
    expect(starts[1]).not.toHaveBeenCalled();
    expect(resumeWorkers).not.toHaveBeenCalled();
    expect(fake.scheduled).toEqual([]);
  });

  it('abort DURING the stagger does not resume workers', async () => {
    const fake = makeFakeScheduler();
    const ran: number[] = [];
    const starts = [0, 1, 2].map((i) => () => ran.push(i));
    const resumeWorkers = vi.fn();
    const controller = new AbortController();

    const run = runBootCoordinator({
      awaitReadiness: async () => 'ready',
      starts,
      staggerOptions,
      resumeWorkers,
      signal: controller.signal,
      scheduler: fake.scheduler,
    });

    await Promise.resolve();
    await Promise.resolve();
    fake.fireIndex(0); // one start runs
    controller.abort(); // abort mid-stagger
    fake.fireAll(); // remaining are no-ops
    await run;

    expect(ran).toEqual([0]);
    expect(resumeWorkers).not.toHaveBeenCalled();
  });
});

describe('isBootStaggerEnabled', () => {
  it('defaults ON (cure enabled) when unset or empty', () => {
    expect(isBootStaggerEnabled(undefined)).toBe(true);
    expect(isBootStaggerEnabled('')).toBe(true);
    expect(isBootStaggerEnabled('true')).toBe(true);
    expect(isBootStaggerEnabled('anything')).toBe(true);
  });

  it('is OFF only for the exact literal "false"', () => {
    expect(isBootStaggerEnabled('false')).toBe(false);
  });
});
