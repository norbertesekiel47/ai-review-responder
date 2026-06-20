const UNSUPPORTED_ROLE_MESSAGE =
  'This account type is no longer supported. Contact your administrator.';

export function mapInitialQueryError(errorParam: string | null | undefined): string {
  if (errorParam === 'account_incomplete') {
    return 'Your account is not set up yet. Contact your administrator.';
  }
  if (errorParam === 'auth_callback_failed') {
    return 'Sign-in failed. Please try again.';
  }
  if (errorParam === 'unsupported_role') {
    return UNSUPPORTED_ROLE_MESSAGE;
  }
  return '';
}

const GENERIC_LOGIN_FAILURE = "Couldn't sign you in. Please try again.";

export function mapSupabaseAuthError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('invalid login credentials')) {
    return 'Email or password is incorrect.';
  }
  if (normalized.includes('too many requests') || normalized.includes('rate limit')) {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }
  // Never surface raw Supabase/server text to the owner — fall back to curated,
  // non-leaky copy for anything we don't explicitly recognise.
  return GENERIC_LOGIN_FAILURE;
}

export function isEmailNotConfirmedError(message: string): boolean {
  return message.toLowerCase().includes('email not confirmed');
}
