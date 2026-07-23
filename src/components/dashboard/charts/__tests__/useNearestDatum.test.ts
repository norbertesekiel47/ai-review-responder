import { describe, expect, it } from 'vitest';
import { nearestIndex } from '@/components/dashboard/charts/useNearestDatum';

describe('nearestIndex', () => {
  it('returns null for an empty position list', () => {
    expect(nearestIndex([], 100)).toBeNull();
  });

  it('picks the closest x position', () => {
    expect(nearestIndex([10, 50, 90], 47)).toBe(1);
    expect(nearestIndex([10, 50, 90], 75)).toBe(2);
  });

  it('clamps to the edges for out-of-range pointers', () => {
    expect(nearestIndex([10, 50, 90], -30)).toBe(0);
    expect(nearestIndex([10, 50, 90], 500)).toBe(2);
  });

  it('breaks ties toward the earlier index', () => {
    expect(nearestIndex([10, 30], 20)).toBe(0);
  });
});
