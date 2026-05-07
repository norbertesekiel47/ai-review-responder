import { describe, expect, it } from 'vitest';
import { mapInitialQueryError, mapSupabaseAuthError, isEmailNotConfirmedError } from '../mapLoginError';

describe('mapInitialQueryError', () => {
  it('maps account_incomplete', () => {
    expect(mapInitialQueryError('account_incomplete')).toMatch(/not set up yet/);
  });
  it('maps auth_callback_failed', () => {
    expect(mapInitialQueryError('auth_callback_failed')).toMatch(/Sign-in failed/);
  });
  it('returns empty for null/unknown', () => {
    expect(mapInitialQueryError(null)).toBe('');
    expect(mapInitialQueryError('mystery')).toBe('');
  });
});

describe('mapSupabaseAuthError', () => {
  it('maps invalid credentials', () => {
    expect(mapSupabaseAuthError('Invalid login credentials')).toMatch(/Email or password is incorrect/);
  });
  it('passes through other messages verbatim (Supabase is the source of truth)', () => {
    expect(mapSupabaseAuthError('Something else')).toBe('Something else');
  });
});

describe('isEmailNotConfirmedError', () => {
  it('matches case-insensitively', () => {
    expect(isEmailNotConfirmedError('Email not confirmed')).toBe(true);
    expect(isEmailNotConfirmedError('email NOT confirmed')).toBe(true);
  });
  it('does not match other messages', () => {
    expect(isEmailNotConfirmedError('Invalid login credentials')).toBe(false);
  });
});
