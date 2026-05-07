import { describe, expect, it } from 'vitest';
import { safeSignupRedirect } from '../safeSignupRedirect';

const FALLBACK = '/signup/check-email';

describe('safeSignupRedirect', () => {
  it('returns fallback for non-string input', () => {
    expect(safeSignupRedirect(undefined)).toBe(FALLBACK);
    expect(safeSignupRedirect(null)).toBe(FALLBACK);
    expect(safeSignupRedirect(42)).toBe(FALLBACK);
    expect(safeSignupRedirect({})).toBe(FALLBACK);
  });
  it('returns fallback for non-absolute paths', () => {
    expect(safeSignupRedirect('signup/check-email')).toBe(FALLBACK);
    expect(safeSignupRedirect('http://evil.com/signup/check-email')).toBe(FALLBACK);
  });
  it('returns fallback for protocol-relative URLs', () => {
    expect(safeSignupRedirect('//evil.com/signup/check-email')).toBe(FALLBACK);
  });
  it('accepts /signup/check-email with a query string', () => {
    expect(safeSignupRedirect('/signup/check-email?email=a%40b.co')).toBe(
      '/signup/check-email?email=a%40b.co',
    );
  });
  it('accepts /signup/finish', () => {
    expect(safeSignupRedirect('/signup/finish')).toBe('/signup/finish');
  });
  it('accepts /onboarding/pay', () => {
    expect(safeSignupRedirect('/onboarding/pay')).toBe('/onboarding/pay');
  });
  it('rejects unknown destinations even when they start with /', () => {
    expect(safeSignupRedirect('/dashboard')).toBe(FALLBACK);
    expect(safeSignupRedirect('/admin/overview')).toBe(FALLBACK);
  });
  it('rejects look-alike paths that share a prefix', () => {
    expect(safeSignupRedirect('/signup/check-email-evil')).toBe(FALLBACK);
    expect(safeSignupRedirect('/signup/finishbad')).toBe(FALLBACK);
  });
  it('strips the fragment before matching', () => {
    expect(safeSignupRedirect('/signup/check-email#welcome')).toBe(
      '/signup/check-email#welcome',
    );
  });
});
