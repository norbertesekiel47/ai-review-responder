import { describe, expect, it } from 'vitest';
import { JudgeOutputSchema } from '../judge-schema';

describe('JudgeOutputSchema', () => {
  it('accepts a bounded verdict with enum-only reasons', () => {
    expect(JudgeOutputSchema.parse({
      verdict: 'flag',
      reasons: ['compensation_or_discount', 'fabricated_fact'],
      rationale: 'The reply invents a refund and promises a discount.',
    })).toEqual({
      verdict: 'flag',
      reasons: ['compensation_or_discount', 'fabricated_fact'],
      rationale: 'The reply invents a refund and promises a discount.',
    });
  });

  it('rejects verdicts outside the stored judge vocabulary', () => {
    expect(() => JudgeOutputSchema.parse({
      verdict: 'error',
      reasons: [],
      rationale: 'Worker failures, not the model, own the error verdict.',
    })).toThrow();
  });

  it('rejects unknown or over-limit reasons and over-limit rationales', () => {
    expect(() => JudgeOutputSchema.parse({
      verdict: 'warn',
      reasons: ['not_a_real_reason'],
      rationale: 'Nope.',
    })).toThrow();
    expect(() => JudgeOutputSchema.parse({
      verdict: 'warn',
      reasons: Array.from({ length: 6 }, () => 'brand_tone'),
      rationale: 'Too many reasons.',
    })).toThrow();
    expect(() => JudgeOutputSchema.parse({
      verdict: 'warn',
      reasons: ['brand_tone'],
      rationale: 'x'.repeat(501),
    })).toThrow();
  });
});
