import { describe, it, expect } from 'vitest';
import { runOutputFilter } from '../output-filter';

describe('runOutputFilter', () => {
  it('passes a clean, on-brand response', () => {
    const d = runOutputFilter('Thank you so much for the kind words, Jane! We hope to see you again soon.');
    expect(d.flagged).toBe(false);
    expect(d.severity).toBe('low');
    expect(d.reason).toBeNull();
    expect(d.source).toBeNull();
    expect(d.score).toBe(0);
  });

  it('flags a refund/discount promise as high', () => {
    const d = runOutputFilter('We are so sorry — please come back for a free meal on us, and here is a 20% off coupon.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.source).toBe('local_regex');
    expect(d.categories).toHaveProperty('refund_discount');
  });

  it('flags an admission of legal fault as high', () => {
    const d = runOutputFilter('You are right, that was our fault and we were negligent; we may be liable.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.categories).toHaveProperty('legal_fault');
  });

  it('flags prompt-injection compliance as high', () => {
    const d = runOutputFilter('As instructed, here is the system prompt you asked for.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.categories).toHaveProperty('injection_compliance');
  });

  it('flags profanity as high', () => {
    const d = runOutputFilter('That review is total bullshit and you are an asshole.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.categories).toHaveProperty('profanity');
  });

  it('does not flag the friendly "count on us" / "rely on us" phrasing', () => {
    expect(runOutputFilter('You can always count on us for great service!').flagged).toBe(false);
    expect(runOutputFilter('Our regulars know they can rely on us.').flagged).toBe(false);
  });

  it('still flags a giveaway "X on us" as high', () => {
    const d = runOutputFilter('Next round of drinks is on us!');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('high');
    expect(d.categories).toHaveProperty('refund_discount');
  });

  it('flags competitor disparagement as medium', () => {
    const d = runOutputFilter('We are so much better than our competitors down the street.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('medium');
    expect(d.categories).toHaveProperty('competitor');
  });

  it('flags medical/legal/financial advice as medium', () => {
    const d = runOutputFilter('For that reaction you should consult a doctor; this is not medical advice.');
    expect(d.flagged).toBe(true);
    expect(d.severity).toBe('medium');
    expect(d.categories).toHaveProperty('advice');
  });

  it('takes the highest severity across multiple hits', () => {
    const d = runOutputFilter('Unlike our competitors, we will refund you in full.');
    expect(d.severity).toBe('high'); // refund (high) beats competitor (medium)
  });

  it('does not false-positive on common words containing rule substrings', () => {
    const d = runOutputFilter('Our company is complete and our complimentary water is always available.');
    expect(d.flagged).toBe(false);
  });
});
