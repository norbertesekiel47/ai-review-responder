import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { selectTerminations, type WedgeRow } from '../select-terminations';

function row(pid: number, ageS: number): WedgeRow {
  return { pid, ageS, backendStart: `2026-07-18 00:00:00.${String(pid).padStart(6, '0')}+00` };
}

describe('selectTerminations', () => {
  it('keeps only rows older than the threshold, oldest-first, capped', () => {
    const rows = [row(1, 100), row(2, 400), row(3, 350), row(4, 50)];
    const { targets, droppedCount } = selectTerminations(rows, { ageThresholdS: 300, cap: 2 });
    // 100s and 50s are below threshold; 400s and 350s survive; cap=2 keeps both.
    expect(targets.map((t) => t.pid)).toEqual([2, 3]);
    expect(droppedCount).toBe(0);
  });

  it('drops candidates beyond the cap and reports the dropped count', () => {
    const rows = [row(1, 400), row(2, 500), row(3, 350)];
    const { targets, droppedCount } = selectTerminations(rows, { ageThresholdS: 300, cap: 1 });
    expect(targets.map((t) => t.pid)).toEqual([2]); // oldest first (500s)
    expect(droppedCount).toBe(2);
  });

  it('returns no targets when the cap is zero (all candidates dropped)', () => {
    const rows = [row(1, 400), row(2, 500)];
    const result = selectTerminations(rows, { ageThresholdS: 300, cap: 0 });
    expect(result.targets).toEqual([]);
    expect(result.droppedCount).toBe(2);
  });
});

// Property tests (fast-check): the invariants declared for the runaway guard and
// the kill-selection are exhaustively exercised — the house style for
// invariant-level coverage (mirrors sentiment.test.ts).
describe('selectTerminations invariants', () => {
  // Unique pids so each target maps back to exactly one input row (needed to
  // assert the oldest-first ordering by the target's age).
  const rowsArb = fc.uniqueArray(
    fc.record({ pid: fc.integer({ min: 1, max: 1_000_000 }), ageS: fc.integer({ min: -100, max: 100_000 }) }),
    { selector: (r) => r.pid, maxLength: 40 },
  ).map((rs) => rs.map((r) => row(r.pid, r.ageS)));
  const capArb = fc.integer({ min: 0, max: 50 });
  const thresholdArb = fc.integer({ min: 0, max: 50_000 });

  it('targets are a subset of the input pids, never exceed the cap, and are oldest-first', () => {
    fc.assert(
      fc.property(rowsArb, thresholdArb, capArb, (rows, ageThresholdS, cap) => {
        const { targets } = selectTerminations(rows, { ageThresholdS, cap });
        const inputByPid = new Map(rows.map((r) => [r.pid, r]));

        // subset of input
        expect(targets.every((t) => inputByPid.has(t.pid))).toBe(true);
        // never exceeds the cap
        expect(targets.length).toBeLessThanOrEqual(cap);
        // every target strictly exceeded the threshold
        expect(targets.every((t) => inputByPid.get(t.pid)!.ageS > ageThresholdS)).toBe(true);
        // oldest-first: ages are non-increasing across the targets
        const ages = targets.map((t) => inputByPid.get(t.pid)!.ageS);
        for (let i = 1; i < ages.length; i++) {
          expect(ages[i - 1]!).toBeGreaterThanOrEqual(ages[i]!);
        }
      }),
    );
  });

  it('droppedCount = (candidates over the threshold) minus targets, and is never negative', () => {
    fc.assert(
      fc.property(rowsArb, thresholdArb, capArb, (rows, ageThresholdS, cap) => {
        const { targets, droppedCount } = selectTerminations(rows, { ageThresholdS, cap });
        const candidateCount = rows.filter((r) => r.ageS > ageThresholdS).length;
        expect(droppedCount).toBe(candidateCount - targets.length);
        expect(droppedCount).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});
