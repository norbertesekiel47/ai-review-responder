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

describe('classifyCycle — cycle classification from the progress snapshot', () => {
  it('classifies a query that never returned as stalled (regardless of total)', () => {
    expect(classifyCycle({ queryCompleted: false, total: 0, dispatched: 0 })).toBe('stalled');
    expect(classifyCycle({ queryCompleted: false, total: 9, dispatched: 0 })).toBe('stalled');
  });

  it('classifies a completed query with an empty account list as drained', () => {
    expect(classifyCycle({ queryCompleted: true, total: 0, dispatched: 0 })).toBe('drained');
  });

  it('classifies dispatched < total as truncated — including zero dispatched after a completed query', () => {
    expect(classifyCycle({ queryCompleted: true, total: 10, dispatched: 3 })).toBe('truncated');
    expect(classifyCycle({ queryCompleted: true, total: 10, dispatched: 0 })).toBe('truncated');
  });

  it('classifies a full drain (dispatched === total) as drained even with a late tail timeout', () => {
    expect(classifyCycle({ queryCompleted: true, total: 10, dispatched: 10 })).toBe('drained');
    expect(classifyCycle({ queryCompleted: true, total: 1, dispatched: 1 })).toBe('drained');
  });
});

describe('evaluateTruncation — sustained-truncation state machine', () => {
  const THRESHOLD = 3;
  const cycleArb = fc.constantFrom<CycleClassification>('truncated', 'drained', 'stalled');

  it('fires exactly on the first crossing to threshold, never re-fires, resets on drain, ignores stalled', () => {
    fc.assert(
      fc.property(fc.array(cycleArb, { maxLength: 60 }), (cycles) => {
        let counter = 0; // the implementation's clamped running counter
        let truncatedRun = 0; // reference: UNCLAMPED truncations since last drain (stalled-transparent)

        for (const cycle of cycles) {
          const runBefore = truncatedRun;
          const { consecutive, alert } = evaluateTruncation(counter, cycle, THRESHOLD);

          if (cycle === 'drained') truncatedRun = 0;
          else if (cycle === 'truncated') truncatedRun += 1;
          // stalled: unchanged

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

  it('a stalled cycle never alerts and never changes the counter', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), (c) => {
        expect(evaluateTruncation(c, 'stalled', THRESHOLD)).toEqual({ consecutive: c, alert: false });
      }),
    );
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
