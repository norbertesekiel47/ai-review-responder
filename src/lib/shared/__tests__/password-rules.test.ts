import { describe, it, expect } from 'vitest';
import { PASSWORD_RULES, MIN_PASSWORD_LENGTH } from '../password-rules';
import { SignupSchema, ResetPasswordSchema } from '../schemas';

// Eval suite for #1090. The defect this pins: the auth forms DISPLAYED a
// "A number" requirement that neither the submit guard nor the Zod schema
// enforced, so a digitless password was marked unmet on screen and accepted by
// the server. The regression class is display and enforcement living in two
// modules that can drift, so every test here asserts the two agree rather than
// asserting the digit rule twice.

const validSignup = (password: string) => ({
  ownerEmail: 'owner@example.com',
  ownerName: 'Owner',
  password,
});

describe('PASSWORD_RULES', () => {
  it('every rule is enforced by passwordSchema', () => {
    // Each rule ships a counterexample that fails ONLY that rule. A rule whose
    // counterexample the schema accepts is the #1090 defect reappearing: a
    // requirement shown on screen that rejects nothing.
    for (const rule of PASSWORD_RULES) {
      expect(rule.test(rule.counterexample), `${rule.label}: counterexample must fail its own rule`).toBe(
        false,
      );
      expect(
        ResetPasswordSchema.safeParse({ password: rule.counterexample }).success,
        `${rule.label}: schema must reject its counterexample`,
      ).toBe(false);
    }
  });

  it('carries a length rule and a digit rule and nothing else', () => {
    // Guidance (mixed case, symbols) belongs to strengthOf, never here: a rule
    // in this list REJECTS a password, and widening it silently tightens the
    // policy for self-serve signup as well as the invite page.
    expect(PASSWORD_RULES.map((rule) => rule.label)).toEqual([
      `At least ${MIN_PASSWORD_LENGTH} characters`,
      'A number',
    ]);
  });
});

describe('passwordSchema', () => {
  it('passwordSchema rejects a password with no digit', () => {
    expect(ResetPasswordSchema.safeParse({ password: 'abcdefghij' }).success).toBe(false);
    expect(SignupSchema.safeParse(validSignup('abcdefghij')).success).toBe(false);
  });

  it('passwordSchema accepts an 8-character password containing a digit', () => {
    expect(ResetPasswordSchema.safeParse({ password: 'abcdefg1' }).success).toBe(true);
    expect(SignupSchema.safeParse(validSignup('abcdefg1')).success).toBe(true);
  });

  it('still rejects a short password that does contain a digit', () => {
    expect(ResetPasswordSchema.safeParse({ password: 'abc1' }).success).toBe(false);
  });

  it('still enforces the 128-character ceiling', () => {
    expect(ResetPasswordSchema.safeParse({ password: `${'a'.repeat(128)}1` }).success).toBe(false);
  });

  it('accepts a digit-only password at the minimum length', () => {
    // Length and digit are the ONLY rules; a digits-only password satisfies
    // both. This pins that no case rule crept in (non_goal of #1090).
    expect(ResetPasswordSchema.safeParse({ password: '12345678' }).success).toBe(true);
  });
});
