// Pure property tests for the reconcile rotation helpers (T1: nextCursor).
// House style: fast-check invariant coverage (mirrors sentiment.test.ts).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  nextCursor,
  classifyCycle,
  evaluateTruncation,
  type CycleClassification,
} from '../billing-reconciliation/reconcile-progress';

// A non-empty list of accounts with distinct ids, plus a dispatched count in
// [1, length] (nextCursor is only called when dispatched > 0).
const claimedRotation = fc
  .array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 20 })
  .map((ids) => ids.map((id, i) => ({ id: `${i}-${id}` }))) // guarantee distinct ids
  .chain((accounts) =>
    fc
      .integer({ min: 1, max: accounts.length })
      .map((dispatched) => ({ accounts, dispatched })),
  );

describe('nextCursor — keyset advance/reset invariants', () => {
  it('returns the last CLAIMED id on a partial cycle', () => {
    fc.assert(
      fc.property(claimedRotation, ({ accounts, dispatched }) => {
        fc.pre(dispatched < accounts.length); // partial only
        expect(nextCursor(dispatched, accounts)).toBe(accounts[dispatched - 1]!.id);
      }),
    );
  });

  it('returns null at rotation end (a fully-drained batch wraps to the top)', () => {
    fc.assert(
      fc.property(claimedRotation, ({ accounts, dispatched }) => {
        fc.pre(dispatched === accounts.length); // drained only
        expect(nextCursor(dispatched, accounts)).toBeNull();
      }),
    );
  });

  it('never returns an id past the claim frontier', () => {
    fc.assert(
      fc.property(claimedRotation, ({ accounts, dispatched }) => {
        const result = nextCursor(dispatched, accounts);
        if (result === null) return;
        const idx = accounts.findIndex((a) => a.id === result);
        expect(idx).toBe(dispatched - 1);
        expect(idx).toBeLessThan(accounts.length);
      }),
    );
  });
});

describe('classifyCycle — outcome-first cycle classification', () => {
  it("classifies an 'ok' (returned) cycle as drained regardless of the snapshot", () => {
    // A returned cycle always fully drained; the snapshot is not even consulted.
    expect(classifyCycle({ queryCompleted: true, total: 10, dispatched: 10 }, 'ok')).toBe('drained');
    expect(classifyCycle({ queryCompleted: true, total: 10, dispatched: 3 }, 'ok')).toBe('drained');
    expect(classifyCycle({ queryCompleted: false, total: 0, dispatched: 0 }, 'ok')).toBe('drained');
  });

  it("classifies an 'error' (non-timeout throw) cycle as stalled, NOT truncated — even after a completed query with partial dispatch", () => {
    // FIX 2a: a post-query non-timeout failure is an infra stall, not a
    // demand-driven truncation. Without the outcome thread this snapshot would
    // read as truncated (queryCompleted && dispatched < total).
    expect(classifyCycle({ queryCompleted: true, total: 10, dispatched: 3 }, 'error')).toBe('stalled');
    expect(classifyCycle({ queryCompleted: true, total: 10, dispatched: 0 }, 'error')).toBe('stalled');
    expect(classifyCycle({ queryCompleted: false, total: 0, dispatched: 0 }, 'error')).toBe('stalled');
  });

  it("classifies a 'timeout' where the query never returned as stalled (regardless of total)", () => {
    expect(classifyCycle({ queryCompleted: false, total: 0, dispatched: 0 }, 'timeout')).toBe('stalled');
    expect(classifyCycle({ queryCompleted: false, total: 9, dispatched: 0 }, 'timeout')).toBe('stalled');
  });

  it("classifies a 'timeout' with a completed query and an empty account list as drained", () => {
    expect(classifyCycle({ queryCompleted: true, total: 0, dispatched: 0 }, 'timeout')).toBe('drained');
  });

  it("classifies a 'timeout' with dispatched < total as truncated — including zero dispatched after a completed query", () => {
    expect(classifyCycle({ queryCompleted: true, total: 10, dispatched: 3 }, 'timeout')).toBe('truncated');
    expect(classifyCycle({ queryCompleted: true, total: 10, dispatched: 0 }, 'timeout')).toBe('truncated');
  });

  it("classifies a 'timeout' full drain (dispatched === total) as drained even with a late tail timeout", () => {
    expect(classifyCycle({ queryCompleted: true, total: 10, dispatched: 10 }, 'timeout')).toBe('drained');
    expect(classifyCycle({ queryCompleted: true, total: 1, dispatched: 1 }, 'timeout')).toBe('drained');
  });
});

describe('evaluateTruncation — sustained-truncation state machine', () => {
  const THRESHOLD = 3;
  const cycleArb = fc.constantFrom<CycleClassification>('truncated', 'drained', 'stalled');

  it('fires exactly on the first crossing to threshold, never re-fires, resets on ANYTHING that is not a truncation (drain OR stall)', () => {
    fc.assert(
      fc.property(fc.array(cycleArb, { maxLength: 60 }), (cycles) => {
        let counter = 0; // the implementation's clamped running counter
        let truncatedRun = 0; // reference: UNCLAMPED consecutive truncations (a non-truncation resets)

        for (const cycle of cycles) {
          const runBefore = truncatedRun;
          const { consecutive, alert } = evaluateTruncation(counter, cycle, THRESHOLD);

          // FIX 2b: "consecutive" is literal — both a drain and a stall break the
          // run. Only an uninterrupted truncation streak advances.
          if (cycle === 'truncated') truncatedRun += 1;
          else truncatedRun = 0;

          // Alert fires iff THIS cycle is the truncation that first reaches the
          // threshold — the (threshold)-th truncation of an uninterrupted run.
          expect(alert).toBe(cycle === 'truncated' && runBefore + 1 === THRESHOLD);
          // The clamped counter always tracks min(run, threshold).
          expect(consecutive).toBe(Math.min(truncatedRun, THRESHOLD));

          counter = consecutive;
        }
      }),
    );
  });

  it('a stalled cycle never alerts and resets the counter to zero (a stall breaks the streak)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), (c) => {
        expect(evaluateTruncation(c, 'stalled', THRESHOLD)).toEqual({ consecutive: 0, alert: false });
      }),
    );
  });

  it('a single stall between two truncations breaks the run (T,S,T,S,T does not reach the threshold)', () => {
    const seq: CycleClassification[] = ['truncated', 'stalled', 'truncated', 'stalled', 'truncated'];
    let counter = 0;
    for (const cycle of seq) {
      const { consecutive, alert } = evaluateTruncation(counter, cycle, THRESHOLD);
      expect(alert).toBe(false); // never three consecutive → never pages
      counter = consecutive;
    }
    expect(counter).toBe(1); // the trailing lone truncation
  });

  it('a drained cycle always resets to zero and never alerts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), (c) => {
        expect(evaluateTruncation(c, 'drained', THRESHOLD)).toEqual({ consecutive: 0, alert: false });
      }),
    );
  });

  it('a truncation at threshold-1 fires; a truncation already at threshold is clamped and silent', () => {
    expect(evaluateTruncation(THRESHOLD - 1, 'truncated', THRESHOLD)).toEqual({ consecutive: THRESHOLD, alert: true });
    expect(evaluateTruncation(THRESHOLD, 'truncated', THRESHOLD)).toEqual({ consecutive: THRESHOLD, alert: false });
  });
});
