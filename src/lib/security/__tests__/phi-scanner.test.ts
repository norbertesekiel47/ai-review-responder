import { describe, expect, it } from 'vitest';
import { detectLikelyPhi, redactPhiForLog } from '../phi-scanner';

describe('phi-scanner', () => {
  it('detects MRN identifiers', () => {
    const result = detectLikelyPhi('Patient MRN 12345 had a great visit');

    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('mrn');
  });

  it('detects diagnosis language', () => {
    const result = detectLikelyPhi('They helped with my diabetes treatment');

    expect(result.matched).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining(['patient_context', 'condition_context']));
  });

  it('detects prescription and medication context', () => {
    const result = detectLikelyPhi('The medication and prescription support was clear');

    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('patient_context');
  });

  it('detects insurance identifiers', () => {
    const result = detectLikelyPhi('Insurance ID ABCD-1234 was handled quickly');

    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('insurance_identifier');
  });

  it('does not flag ordinary restaurant reviews', () => {
    expect(detectLikelyPhi('Great service and friendly staff.').matched).toBe(false);
  });

  it('does not flag ordinary local-business review language', () => {
    const result = detectLikelyPhi('The team fixed my appointment mix-up and the front desk was friendly.');

    expect(result.matched).toBe(false);
  });

  it('redacts raw text for logs', () => {
    expect(redactPhiForLog('Patient MRN 12345')).toBe('[redacted-review-text]');
  });
});
