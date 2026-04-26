import { NextResponse } from 'next/server';

/**
 * Standard "no enumeration leak" response for the signup/finish-signup paths.
 * Returning the same body from the advisory-locked pre-check hit AND from the
 * Supabase signUp / DuplicateEmailError branches prevents callers from using
 * timing/content differences to probe which emails have Supabase Auth
 * identities vs app users rows.
 */
export function accountExistsResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'account_exists',
      message:
        'An account with this email already exists. Try logging in or use forgot password.',
    },
    { status: 409 },
  );
}
