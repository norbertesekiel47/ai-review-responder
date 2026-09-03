import { describe, expect, it } from 'vitest';
import { strengthOf, STRENGTH_LABELS, passwordRequirements } from '../strength';
import { PASSWORD_RULES } from '@/lib/shared/password-rules';

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

// #1090: the requirements list is the USER-FACING face of PASSWORD_RULES, and
// the two must not be able to drift. The defect this replaces was exactly that
// drift — the list showed "A number" while nothing enforced it.
describe('passwordRequirements', () => {
  it("the reset form's displayed requirements and the schema agree on every rule", () => {
    const shown = passwordRequirements('abcdefghij');
    expect(shown.map((requirement) => requirement.label)).toEqual(
      PASSWORD_RULES.map((rule) => rule.label),
    );
  });

  it('marks the number requirement unmet for a digitless password', () => {
    const digit = passwordRequirements('abcdefghij').find((r) => r.label === 'A number');
    expect(digit?.met).toBe(false);
  });

  it('marks every requirement met for a password the schema accepts', () => {
    expect(passwordRequirements('abcdefg1').every((requirement) => requirement.met)).toBe(true);
  });

  it('does not present mixed case as a requirement', () => {
    // Mixed case is scored by strengthOf as GUIDANCE. Listing it here would
    // claim a rule the server does not enforce — the #1090 defect inverted.
    expect(passwordRequirements('abcdefg1').map((r) => r.label)).not.toContain(
      'Upper & lowercase letters',
    );
  });
});
