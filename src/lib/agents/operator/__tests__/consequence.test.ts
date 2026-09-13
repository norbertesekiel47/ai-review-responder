// Unit tests for src/lib/agents/operator/consequence.ts. Every expected count
// is worked out by hand from the fixture table beside it — never recomputed
// with the module's own logic.
//
// The policy module is wrapped with `importOriginal` so both predicates stay
// REAL but observable: the spy test proves the simulator calls the
// publisher's `starMeetsThreshold` and `resolveDailyCap` instead of copies.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auto-approval/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auto-approval/policy')>();
  return {
    ...actual,
    starMeetsThreshold: vi.fn(actual.starMeetsThreshold),
    resolveDailyCap: vi.fn(actual.resolveDailyCap),
  };
});

import { resolveDailyCap, starMeetsThreshold } from '@/lib/auto-approval/policy';
import { type ConsequenceReview, simulateRule } from '../consequence';

const DAY_1 = '2026-09-01 00:00:00+00';
const DAY_2 = '2026-09-02 00:00:00+00';

function review(
  reviewId: string,
  businessId: string,
  stars: number | null,
  dayKey: string,
  detectedAt: string,
  imported = false,
): ConsequenceReview {
  return { reviewId, businessId, stars, dayKey, detectedAt, imported };
}

beforeEach(() => {
  vi.mocked(starMeetsThreshold).mockClear();
  vi.mocked(resolveDailyCap).mockClear();
});

describe('simulateRule', () => {
  it('returns zeros for empty input', () => {
    expect(simulateRule([], {})).toEqual({
      total: 0,
      eligible: 0,
      held: { below_threshold: 0, cap_reached: 0, manual: 0 },
      byDay: [],
      busiestDay: 0,
    });
  });

  it('partitions a hand-counted 10-review table', () => {
    // biz-a: threshold 4, cap 2 · biz-b: threshold 5, default cap · biz-c: manual
    //
    // id   biz  stars  day   time   → outcome
    // r01  a    5      D1    09:00  eligible (a/D1 = 1)
    // r02  a    4      D1    10:00  eligible (a/D1 = 2)
    // r03  a    3      D1    11:00  below_threshold
    // r04  a    5      D1    12:00  cap_reached (a/D1 already 2)
    // r05  b    5      D1    09:30  eligible
    // r06  b    4      D1    09:45  below_threshold
    // r07  a    null   D2    08:00  below_threshold
    // r08  b    5      D2    08:30  imported → excluded
    // r09  c    5      D2    09:00  manual
    // r10  c    2      D2    10:00  manual
    //
    // total 9 · eligible 3 · below 3 · cap 1 · manual 2
    // D1: total 6, eligible 3, held 3 · D2: total 3, eligible 0, held 3
    const reviews = [
      review('r01', 'biz-a', 5, DAY_1, '2026-09-01T09:00:00.000Z'),
      review('r02', 'biz-a', 4, DAY_1, '2026-09-01T10:00:00.000Z'),
      review('r03', 'biz-a', 3, DAY_1, '2026-09-01T11:00:00.000Z'),
      review('r04', 'biz-a', 5, DAY_1, '2026-09-01T12:00:00.000Z'),
      review('r05', 'biz-b', 5, DAY_1, '2026-09-01T09:30:00.000Z'),
      review('r06', 'biz-b', 4, DAY_1, '2026-09-01T09:45:00.000Z'),
      review('r07', 'biz-a', null, DAY_2, '2026-09-02T08:00:00.000Z'),
      review('r08', 'biz-b', 5, DAY_2, '2026-09-02T08:30:00.000Z', true),
      review('r09', 'biz-c', 5, DAY_2, '2026-09-02T09:00:00.000Z'),
      review('r10', 'biz-c', 2, DAY_2, '2026-09-02T10:00:00.000Z'),
    ];
    const result = simulateRule(reviews, {
      'biz-a': { threshold: 4, dailyCap: 2 },
      'biz-b': { threshold: 5, dailyCap: null },
      'biz-c': { threshold: null, dailyCap: 5 },
    });

    expect(result).toEqual({
      total: 9,
      eligible: 3,
      held: { below_threshold: 3, cap_reached: 1, manual: 2 },
      byDay: [
        { day: DAY_1, total: 6, eligible: 3, held: 3 },
        { day: DAY_2, total: 3, eligible: 0, held: 3 },
      ],
      busiestDay: 6,
    });
  });

  it('holds the third qualifying review when the cap is 2 on one business/day', () => {
    const result = simulateRule(
      [
        review('r1', 'biz-a', 5, DAY_1, '2026-09-01T09:00:00.000Z'),
        review('r2', 'biz-a', 5, DAY_1, '2026-09-01T10:00:00.000Z'),
        review('r3', 'biz-a', 5, DAY_1, '2026-09-01T11:00:00.000Z'),
      ],
      { 'biz-a': { threshold: 4, dailyCap: 2 } },
    );

    expect(result.eligible).toBe(2);
    expect(result.held).toEqual({ below_threshold: 0, cap_reached: 1, manual: 0 });
    expect(result.byDay).toEqual([{ day: DAY_1, total: 3, eligible: 2, held: 1 }]);
  });

  it('resets the cap on the next day and keeps each business cap independent', () => {
    // cap 1 each: a/D1 → 1 eligible + 1 cap · a/D2 → 1 eligible · b/D1 → 1 eligible
    const result = simulateRule(
      [
        review('a1', 'biz-a', 5, DAY_1, '2026-09-01T09:00:00.000Z'),
        review('a2', 'biz-a', 5, DAY_1, '2026-09-01T10:00:00.000Z'),
        review('a3', 'biz-a', 5, DAY_2, '2026-09-02T09:00:00.000Z'),
        review('b1', 'biz-b', 5, DAY_1, '2026-09-01T11:00:00.000Z'),
      ],
      {
        'biz-a': { threshold: 4, dailyCap: 1 },
        'biz-b': { threshold: 4, dailyCap: 1 },
      },
    );

    expect(result.eligible).toBe(3);
    expect(result.held).toEqual({ below_threshold: 0, cap_reached: 1, manual: 0 });
    expect(result.byDay).toEqual([
      { day: DAY_1, total: 3, eligible: 2, held: 1 },
      { day: DAY_2, total: 1, eligible: 1, held: 0 },
    ]);
  });

  it('classifies every review as manual when the threshold is null', () => {
    const result = simulateRule(
      [
        review('r1', 'biz-c', 5, DAY_1, '2026-09-01T09:00:00.000Z'),
        review('r2', 'biz-c', 4, DAY_1, '2026-09-01T10:00:00.000Z'),
        review('r3', 'biz-c', 1, DAY_1, '2026-09-01T11:00:00.000Z'),
        review('r4', 'biz-c', null, DAY_1, '2026-09-01T12:00:00.000Z'),
      ],
      { 'biz-c': { threshold: null, dailyCap: 10 } },
    );

    expect(result.total).toBe(4);
    expect(result.eligible).toBe(0);
    expect(result.held).toEqual({ below_threshold: 0, cap_reached: 0, manual: 4 });
    expect(result.byDay).toEqual([{ day: DAY_1, total: 4, eligible: 0, held: 4 }]);
  });

  it('holds null-star reviews as below_threshold without consuming the cap', () => {
    // cap 1: two null stars first, then a 5 — the 5 still fits under the cap.
    const result = simulateRule(
      [
        review('r1', 'biz-a', null, DAY_1, '2026-09-01T09:00:00.000Z'),
        review('r2', 'biz-a', null, DAY_1, '2026-09-01T10:00:00.000Z'),
        review('r3', 'biz-a', 5, DAY_1, '2026-09-01T11:00:00.000Z'),
      ],
      { 'biz-a': { threshold: 4, dailyCap: 1 } },
    );

    expect(result.eligible).toBe(1);
    expect(result.held).toEqual({ below_threshold: 2, cap_reached: 0, manual: 0 });
  });

  it('excludes imported high ratings from every count and from the cap', () => {
    // cap 1: two imported 5s come first on D1; the one live 5 is still eligible.
    // D2 holds only an imported review, so D2 is absent from byDay.
    const result = simulateRule(
      [
        review('i1', 'biz-a', 5, DAY_1, '2026-09-01T08:00:00.000Z', true),
        review('i2', 'biz-a', 5, DAY_1, '2026-09-01T08:30:00.000Z', true),
        review('r1', 'biz-a', 5, DAY_1, '2026-09-01T09:00:00.000Z'),
        review('i3', 'biz-a', 5, DAY_2, '2026-09-02T08:00:00.000Z', true),
      ],
      { 'biz-a': { threshold: 4, dailyCap: 1 } },
    );

    expect(result).toEqual({
      total: 1,
      eligible: 1,
      held: { below_threshold: 0, cap_reached: 0, manual: 0 },
      byDay: [{ day: DAY_1, total: 1, eligible: 1, held: 0 }],
      busiestDay: 1,
    });
  });

  it('is deterministic for unordered input and does not mutate it', () => {
    // cap 1 on D1: the 09:00 review wins the slot, so the 10:00 review is held
    // either way. byDay comes back in ascending day order.
    const inDateOrder = [
      review('r1', 'biz-a', 5, DAY_1, '2026-09-01T09:00:00.000Z'),
      review('r2', 'biz-a', 5, DAY_1, '2026-09-01T10:00:00.000Z'),
      review('r3', 'biz-a', 3, DAY_2, '2026-09-02T09:00:00.000Z'),
    ] as const;
    const shuffled = Object.freeze([inDateOrder[2], inDateOrder[1], inDateOrder[0]]);
    const snapshot = structuredClone([...shuffled]);
    const dials = { 'biz-a': { threshold: 4, dailyCap: 1 } } as const;

    const expected = {
      total: 3,
      eligible: 1,
      held: { below_threshold: 1, cap_reached: 1, manual: 0 },
      byDay: [
        { day: DAY_1, total: 2, eligible: 1, held: 1 },
        { day: DAY_2, total: 1, eligible: 0, held: 1 },
      ],
      busiestDay: 2,
    };
    expect(simulateRule(shuffled, dials)).toEqual(expected);
    expect(simulateRule(inDateOrder, dials)).toEqual(expected);
    expect([...shuffled]).toEqual(snapshot);
  });

  it('calls the shared threshold predicate for every non-imported review, including a null threshold', () => {
    simulateRule(
      [
        review('r1', 'biz-a', 5, DAY_1, '2026-09-01T09:00:00.000Z'),
        review('r2', 'biz-a', 2, DAY_1, '2026-09-01T10:00:00.000Z'),
        review('r3', 'biz-c', 5, DAY_1, '2026-09-01T11:00:00.000Z'),
        review('i1', 'biz-a', 4, DAY_1, '2026-09-01T12:00:00.000Z', true),
      ],
      {
        'biz-a': { threshold: 4, dailyCap: 3 },
        'biz-c': { threshold: null, dailyCap: 3 },
      },
    );

    expect(vi.mocked(starMeetsThreshold)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(starMeetsThreshold)).toHaveBeenCalledWith(5, 4);
    expect(vi.mocked(starMeetsThreshold)).toHaveBeenCalledWith(2, 4);
    expect(vi.mocked(starMeetsThreshold)).toHaveBeenCalledWith(5, null);
    expect(vi.mocked(starMeetsThreshold)).not.toHaveBeenCalledWith(4, 4);
  });

  it('resolves a null cap to the platform default: 11 qualifying reviews → 10 eligible', () => {
    const reviews = Array.from({ length: 11 }, (_, i) =>
      review(`r${String(i).padStart(2, '0')}`, 'biz-a', 5, DAY_1, `2026-09-01T${String(i + 8).padStart(2, '0')}:00:00.000Z`),
    );
    const result = simulateRule(reviews, { 'biz-a': { threshold: 4, dailyCap: null } });

    expect(result.eligible).toBe(10);
    expect(result.held).toEqual({ below_threshold: 0, cap_reached: 1, manual: 0 });
    expect(vi.mocked(resolveDailyCap)).toHaveBeenCalledWith({ dailyAutoPostCap: null });
  });

  it('ignores imported-only businesses before looking up their dials', () => {
    expect(simulateRule([review('imported', 'unknown', 5, DAY_1, '2026-09-01T09:00:00.000Z', true)], {}))
      .toEqual({ total: 0, eligible: 0, held: { below_threshold: 0, cap_reached: 0, manual: 0 }, byDay: [], busiestDay: 0 });
    expect(starMeetsThreshold).not.toHaveBeenCalled();
  });

  it('throws a descriptive error when a business has no dials', () => {
    expect(() =>
      simulateRule([review('r1', 'biz-x', 5, DAY_1, '2026-09-01T09:00:00.000Z')], {
        'biz-a': { threshold: 4, dailyCap: 2 },
      }),
    ).toThrow(/no auto-approval dials supplied for business biz-x \(review r1\)/);
    // An inherited Object key is not a policy either.
    expect(() =>
      simulateRule([review('r1', 'constructor', 5, DAY_1, '2026-09-01T09:00:00.000Z')], {}),
    ).toThrow(/business constructor/);
  });
});
