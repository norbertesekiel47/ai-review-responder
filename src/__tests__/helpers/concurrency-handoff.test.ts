// Unit tests for the #889 bounded-wait helper.
//
// DB-free on purpose. The guard exists to make a live-DB hang legible, so its
// OWN failure paths must not themselves depend on a live database — otherwise
// the only way to test them is fault injection inside the suite it guards, and
// a guard proven only by fault injection is a guard proven once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startStage } from './concurrency-handoff';

/** A promise with exposed settlers, matching the suites' `deferred()` shape. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Never settles. Used where a race must be decided by another participant. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const BUDGET = { budgetMs: 30_000 } as const;

describe('startStage', () => {
  let unhandled: unknown[];

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', (reason) => { unhandled.push(reason); });
  });

  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    vi.useRealTimers();
  });

  describe('target settlement', () => {
    it('returns the operation value from awaitSettled', async () => {
      const stage = startStage('webhook', Promise.resolve({ kind: 'updated' }), BUDGET);
      await expect(stage.awaitSettled()).resolves.toEqual({ kind: 'updated' });
    });

    it('propagates a non-cancellation rejection untouched', async () => {
      const boom = new Error('publisher blew up');
      const stage = startStage('publisher', Promise.reject(boom), BUDGET);
      await expect(stage.awaitSettled()).rejects.toBe(boom);
    });

    it('returns from awaitHandoff when the signal arrives first', async () => {
      const signal = deferred();
      const stage = startStage('webhook', pending<void>(), BUDGET);
      const wait = stage.awaitHandoff('retrieveEntered', signal.promise);
      signal.resolve();
      await expect(wait).resolves.toBeUndefined();
    });
  });

  describe('cancellation rejections gain a dump', () => {
    it('wraps SQLSTATE 57014 in a NEW error whose cause is the original', async () => {
      const canceled = Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      });
      const stage = startStage('publisher', Promise.reject(canceled), {
        ...BUDGET,
        diagnose: async () => 'PID 42 blocked_by [43]',
      });

      const error = await stage.awaitSettled().then(
        () => { throw new Error('expected a rejection'); },
        (caught: unknown) => caught as Error,
      );

      expect(error).not.toBe(canceled);
      expect(error.cause).toBe(canceled);
      // Never an error whose cause is itself.
      expect(error.cause).not.toBe(error);
      expect(error.message).toContain('SQLSTATE 57014');
      expect(error.message).toContain('PID 42 blocked_by [43]');
      expect(error.message).toContain('not by itself proof of a lock wait');
    });

    it('detects a cancellation by message when no code is attached', async () => {
      const stage = startStage('publisher', Promise.reject(new Error('canceling statement')), {
        ...BUDGET,
        diagnose: async () => 'dump-body',
      });
      await expect(stage.awaitSettled()).rejects.toThrow(/dump-body/);
    });
  });

  describe('an in-flight peer settling first', () => {
    it('reports the resolved value so an ignored-outcome reason survives', async () => {
      const operation = Promise.resolve({ kind: 'ignored', reason: 'stale_subscription' });
      const stage = startStage('webhook', operation, BUDGET);

      await expect(
        stage.awaitHandoff('retrieveEntered', pending<void>()),
      ).rejects.toThrow(/stale_subscription/);
    });

    it('names the stage and explains it can never be signalled', async () => {
      const stage = startStage('webhook', Promise.resolve('done'), BUDGET);
      await expect(
        stage.awaitHandoff('retrieveEntered', pending<void>()),
      ).rejects.toThrow(/in-flight operation "webhook" settled before this stage was reached/);
    });

    it('preserves the peer rejection as cause', async () => {
      const boom = new Error('AccountNotProvisionedYetError');
      const stage = startStage('webhook', Promise.reject(boom), BUDGET);

      const error = await stage.awaitHandoff('retrieveEntered', pending<void>()).then(
        () => { throw new Error('expected a rejection'); },
        (caught: unknown) => caught as Error,
      );

      expect(error.cause).toBe(boom);
      expect(error.message).toContain('it rejected');
    });

    it('does not serialise an unserialisable value into a throw', async () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const stage = startStage('webhook', Promise.resolve(cyclic), BUDGET);
      await expect(
        stage.awaitHandoff('retrieveEntered', pending<void>()),
      ).rejects.toThrow(/<unserializable>/);
    });
  });

  describe('the watchdog', () => {
    it('fires with the dump when nothing settles', async () => {
      const stage = startStage('webhook', pending<void>(), {
        ...BUDGET,
        maxWaitMs: 20,
        diagnose: async () => 'idle in transaction, blocked_by []',
      });
      await expect(
        stage.awaitHandoff('retrieveEntered', pending<void>()),
      ).rejects.toThrow(/idle in transaction, blocked_by \[\]/);
    });

    it('names the watchdog so it is not mistaken for the suite timeout', async () => {
      const stage = startStage('webhook', pending<void>(), { ...BUDGET, maxWaitMs: 20 });
      await expect(
        stage.awaitHandoff('retrieveEntered', pending<void>()),
      ).rejects.toThrow(/watchdog, not the suite timeout/);
    });

    it('measures from startStage, not from the first await', async () => {
      // Drive the stage's clock explicitly rather than sleeping: a wall-clock
      // assertion here would be exactly the load-sensitive flake this helper
      // exists to eliminate.
      let clock = 0;
      const stage = startStage('webhook', pending<void>(), {
        ...BUDGET,
        maxWaitMs: 1_000,
        now: () => clock,
      });
      // 990ms of the 1000ms watchdog elapses BEFORE the first await.
      clock = 990;

      const startedWaitingAt = Date.now();
      await expect(
        stage.awaitHandoff('retrieveEntered', pending<void>()),
      ).rejects.toThrow(/watchdog/);
      // ~10ms of budget was left. The bound is loose on purpose — it only has
      // to prove the wait was NOT a fresh 1000ms measured from the await.
      expect(Date.now() - startedWaitingAt).toBeLessThan(500);
    });

    it('still throws the deadline error when diagnose rejects', async () => {
      const stage = startStage('webhook', pending<void>(), {
        ...BUDGET,
        maxWaitMs: 20,
        diagnose: async () => { throw new Error('observer is down'); },
      });
      const error = await stage.awaitHandoff('retrieveEntered', pending<void>()).then(
        () => { throw new Error('expected a rejection'); },
        (caught: unknown) => caught as Error,
      );
      expect(error.message).toContain('no signal within');
      expect(error.message).toContain('diagnostics unavailable');
      expect(error.message).toContain('observer is down');
    });

    it('still throws the deadline error when diagnose overruns its own budget', async () => {
      const stage = startStage('webhook', pending<void>(), {
        ...BUDGET,
        maxWaitMs: 20,
        diagnoseMs: 20,
        diagnose: () => pending<string>(),
      });
      const error = await stage.awaitHandoff('retrieveEntered', pending<void>()).then(
        () => { throw new Error('expected a rejection'); },
        (caught: unknown) => caught as Error,
      );
      expect(error.message).toContain('overran its 20ms budget');
    });

    it('reports when there was no budget left to collect diagnostics', async () => {
      // usable === maxWaitMs, so the diagnose budget clamps to 0.
      const stage = startStage('webhook', pending<void>(), {
        budgetMs: 3_020,
        reserveMs: 3_000,
        maxWaitMs: 20,
        diagnose: async () => 'never reached',
      });
      await expect(
        stage.awaitHandoff('retrieveEntered', pending<void>()),
      ).rejects.toThrow(/no budget left for collection/);
    });
  });

  describe('budget exhaustion', () => {
    it('throws at startStage without waiting when the reserve is already spent', () => {
      expect(() => startStage('webhook', pending<void>(), { budgetMs: 3_000, reserveMs: 3_000 }))
        .toThrow(/test budget exhausted before the stage began/);
    });

    it('reports both numbers so the cause is obvious', () => {
      expect(() => startStage('webhook', pending<void>(), { budgetMs: 1_000, reserveMs: 3_000 }))
        .toThrow(/budgetMs=1000, reserveMs=3000/);
    });

    it('handles the already-rejected operation without an unhandled rejection', async () => {
      const rejected = Promise.reject(new Error('early'));
      expect(() => startStage('webhook', rejected, { budgetMs: 10, reserveMs: 3_000 })).toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    });
  });

  describe('hygiene', () => {
    it('leaves no pending timer behind after a successful wait', async () => {
      vi.useFakeTimers();
      const signal = deferred();
      const stage = startStage('webhook', pending<void>(), { ...BUDGET, maxWaitMs: 5_000 });
      const wait = stage.awaitHandoff('retrieveEntered', signal.promise);
      signal.resolve();
      await wait;
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no unhandled rejection when a losing peer rejects later', async () => {
      const peer = deferred();
      const stage = startStage('webhook', pending<void>(), { ...BUDGET, peers: [peer.promise] });
      const signal = deferred();
      const wait = stage.awaitHandoff('retrieveEntered', signal.promise);
      signal.resolve();
      await wait;

      peer.reject(new Error('late peer failure'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    });
  });
});
