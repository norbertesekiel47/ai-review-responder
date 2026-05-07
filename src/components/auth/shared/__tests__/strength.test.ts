import { describe, expect, it } from 'vitest';
import { strengthOf, STRENGTH_LABELS } from '../strength';

describe('strengthOf', () => {
  it('returns 0 for empty input', () => {
    expect(strengthOf('')).toBe(0);
  });
  it('returns 1 once length reaches 8', () => {
    expect(strengthOf('abcdefgh')).toBe(1);
  });
  it('returns 2 with mixed case at length 8', () => {
    expect(strengthOf('Abcdefgh')).toBe(2);
  });
  it('returns 3 with mixed case + digit at length 8', () => {
    expect(strengthOf('Abcdefg1')).toBe(3);
  });
  it('returns 4 with mixed case + digit + symbol at length 10', () => {
    expect(strengthOf('Abcdefg1!_')).toBe(4);
  });
  it('does not award the symbol bar below length 10', () => {
    expect(strengthOf('Abcdefg1!')).toBe(3);
  });
});

describe('STRENGTH_LABELS', () => {
  it('has five entries (indices 0-4)', () => {
    expect(STRENGTH_LABELS).toHaveLength(5);
  });
});
