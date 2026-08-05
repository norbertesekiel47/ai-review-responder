import { describe, expect, it } from 'vitest';
import type { AuthError } from '@supabase/supabase-js';
import { mapUpdateUserError } from '../reset-password-error';

// AuthError extends Error — build fixtures the same shape production code
// throws, so `instanceof Error` checks downstream (reportCaughtError) see a
// real Error the way they do in production.
function fakeAuthError(overrides: {
  message: string;
  status?: number;
  code?: string;
}): AuthError {
  return Object.assign(new Error(overrides.message), {
    status: overrides.status,
    code: overrides.code,
  }) as unknown as AuthError;
}

describe('mapUpdateUserError', () => {
  it('maps insufficient_aal to 403 mfa_required regardless of the provider status, with no report', () => {
    const error = fakeAuthError({
      code: 'insufficient_aal',
      status: 401,
      message: 'AAL2 session is required to update email or password when MFA is enabled.',
    });

    expect(mapUpdateUserError(error)).toEqual({
      status: 403,
      body: { error: 'mfa_required' },
    });
  });

  it('passes an in-range provider status through verbatim with no report', () => {
    const error = fakeAuthError({
      status: 422,
      message: 'New password should be different from the old one.',
    });

    expect(mapUpdateUserError(error)).toEqual({
      status: 422,
      body: { error: 'New password should be different from the old one.' },
    });
  });

  it('passes a bare 401 through as 401 and reports it as unmapped', () => {
    const error = fakeAuthError({ status: 401, message: 'Invalid session' });

    expect(mapUpdateUserError(error)).toEqual({
      status: 401,
      body: { error: 'Invalid session' },
      report: {
        reason: 'update_user_unmapped_401',
        providerCode: undefined,
        providerStatus: 401,
      },
    });
  });

  it('clamps a status-0 transport error to 400 and reports it as unusable', () => {
    const error = fakeAuthError({ status: 0, message: 'Failed to fetch' });

    expect(mapUpdateUserError(error)).toEqual({
      status: 400,
      body: { error: 'Failed to fetch' },
      report: {
        reason: 'update_user_unusable_status',
        providerCode: undefined,
        providerStatus: 0,
      },
    });
  });

  it('clamps a missing/undefined status to 400 and reports it as unusable', () => {
    const error = fakeAuthError({ message: 'unexpected' });

    expect(mapUpdateUserError(error)).toEqual({
      status: 400,
      body: { error: 'unexpected' },
      report: {
        reason: 'update_user_unusable_status',
        providerCode: undefined,
        providerStatus: undefined,
      },
    });
  });

  it('does not report an ordinary in-range validation status', () => {
    const error = fakeAuthError({ status: 400, message: 'Weak password' });

    const result = mapUpdateUserError(error);

    expect(result.report).toBeUndefined();
  });
});
