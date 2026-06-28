import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createGuardedPoll } from '../guarded-poll';

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('createGuardedPoll', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('runOnce', () => {
    it('runs the cycle and passes the logger through', async () => {
      const logger = makeLogger();
      const runCycle = vi.fn(async (l: unknown) => {
        expect(l).toBe(logger);
      });
      const { runOnce } = createGuardedPoll(runCycle, {
        timeoutMs: 10_000,
        label: '[X]',
        intervalMs: 1_000,
        logger,
      });

      await runOnce();

      expect(runCycle).toHaveBeenCalledTimes(1);
    });

    it('single-flight: a tick is skipped while a previous cycle is in flight', async () => {
      const logger = makeLogger();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const { runOnce } = createGuardedPoll(
        () => {
          calls += 1;
          return gate;
        },
        { timeoutMs: 10_000, label: '[X]', intervalMs: 1_000, logger, onSkipMessage: 'still running' },
      );

      const first = runOnce(); // in flight, awaiting gate
      await runOnce(); // skipped

      expect(calls).toBe(1);
      expect(logger.log).toHaveBeenCalledWith('still running');

      release();
      await first;

      // flag released after the first cycle settles → a later tick runs again
      await runOnce();
      expect(calls).toBe(2);
    });

    it('single-flight skip is silent when onSkipMessage is omitted', async () => {
      const logger = makeLogger();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { runOnce } = createGuardedPoll(() => gate, {
        timeoutMs: 10_000,
        label: '[X]',
        intervalMs: 1_000,
        logger,
      });

      const first = runOnce();
      await runOnce(); // skipped, no log

      expect(logger.log).not.toHaveBeenCalled();

      release();
      await first;
    });

    it('bounds a hung cycle, logs the error, and resets so the next tick runs', async () => {
      vi.useFakeTimers();
      try {
        const logger = makeLogger();
        let calls = 0;
        const { runOnce } = createGuardedPoll(
          () => {
            calls += 1;
            return new Promise<void>(() => {}); // never settles
          },
          { timeoutMs: 1_000, label: '[X]', intervalMs: 5_000, logger },
        );

        const first = runOnce();
        await vi.advanceTimersByTimeAsync(1_000); // trip the withTimeout deadline

        await expect(first).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalledWith('Poll cycle failed', expect.any(Error));

        // flag reset → the next tick actually invokes the cycle again
        void runOnce();
        await Promise.resolve();
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not trip the deadline for a cycle that finishes in time', async () => {
      vi.useFakeTimers();
      try {
        const logger = makeLogger();
        const { runOnce } = createGuardedPoll(async () => {}, {
          timeoutMs: 1_000,
          label: '[X]',
          intervalMs: 5_000,
          logger,
        });

        await runOnce();
        await vi.advanceTimersByTimeAsync(5_000); // well past the deadline

        expect(logger.error).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('catches a thrown cycle with onErrorMessage and resets the flag', async () => {
      const logger = makeLogger();
      let calls = 0;
      const { runOnce } = createGuardedPoll(
        () => {
          calls += 1;
          return Promise.reject(new Error('boom'));
        },
        {
          timeoutMs: 10_000,
          label: '[X]',
          intervalMs: 1_000,
          logger,
          onErrorMessage: 'Scheduler cycle failed',
        },
      );

      await runOnce();
      expect(logger.error).toHaveBeenCalledWith('Scheduler cycle failed', expect.any(Error));

      await runOnce(); // flag reset → runs again
      expect(calls).toBe(2);
    });

    it('falls back to createWorkerLogger(label) when no logger is supplied', async () => {
      // Smoke: with no options.logger and a throwing cycle, runOnce must still
      // resolve (the default logger swallows the error) rather than reject.
      const { runOnce } = createGuardedPoll(() => Promise.reject(new Error('boom')), {
        timeoutMs: 10_000,
        label: '[GuardedPollDefaultLogger]',
        intervalMs: 1_000,
      });
      await expect(runOnce()).resolves.toBeUndefined();
    });
  });

  describe('start / stop', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('runs the cycle once immediately and arms a single interval', async () => {
      const logger = makeLogger();
      let calls = 0;
      const onStart = vi.fn();
      const { start, stop } = createGuardedPoll(
        async () => {
          calls += 1;
        },
        { timeoutMs: 1_000, label: '[X]', intervalMs: 5_000, logger },
      );

      start(onStart);
      await vi.advanceTimersByTimeAsync(0); // drain initial cycle + its deadline timer

      expect(onStart).toHaveBeenCalledTimes(1);
      expect(calls).toBe(1); // initial run
      expect(vi.getTimerCount()).toBe(1); // only the interval remains

      await vi.advanceTimersByTimeAsync(5_000); // one interval tick
      expect(calls).toBe(2);

      stop();
    });

    it('is idempotent: a second start does not arm a second timer or re-run onStart', async () => {
      const logger = makeLogger();
      const onStart = vi.fn();
      const { start, stop } = createGuardedPoll(async () => {}, {
        timeoutMs: 1_000,
        label: '[X]',
        intervalMs: 5_000,
        logger,
      });

      start(onStart);
      start(onStart); // no-op
      await vi.advanceTimersByTimeAsync(0);

      expect(onStart).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      stop();
    });

    it('resolves a function intervalMs at start time', () => {
      const logger = makeLogger();
      const intervalMs = vi.fn(() => 250);
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const { start, stop } = createGuardedPoll(async () => {}, {
        timeoutMs: 1_000,
        label: '[X]',
        intervalMs,
        logger,
      });

      start();

      expect(intervalMs).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]![1]).toBe(250);

      stop();
      setIntervalSpy.mockRestore();
    });

    it('stop clears the timer and logs "Stopped"', async () => {
      const logger = makeLogger();
      const { start, stop } = createGuardedPoll(async () => {}, {
        timeoutMs: 1_000,
        label: '[X]',
        intervalMs: 5_000,
        logger,
      });

      start();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(logger.log).toHaveBeenCalledWith('Stopped');
    });

    it('stop is safe (no log, no throw) when never started', () => {
      const logger = makeLogger();
      const { stop } = createGuardedPoll(async () => {}, {
        timeoutMs: 1_000,
        label: '[X]',
        intervalMs: 5_000,
        logger,
      });

      expect(() => stop()).not.toThrow();
      expect(logger.log).not.toHaveBeenCalled();
    });

    it('handles a falsy setInterval handle: start is still idempotent and stop clears it', () => {
      const logger = makeLogger();
      const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as never);
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      const { start, stop } = createGuardedPoll(async () => {}, {
        timeoutMs: 1_000,
        label: '[X]',
        intervalMs: 5_000,
        logger,
      });

      start();
      start(); // idempotent even though the handle is 0 (falsy)
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      stop();
      expect(clearIntervalSpy).toHaveBeenCalledWith(0);
      expect(logger.log).toHaveBeenCalledWith('Stopped');

      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });
  });
});
