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
  if (errorParam === 'account_not_found') {
    // Emitted by the owner shell (UX audit D4) when a signed-in Supabase user
    // has no app row, or an owner row has no account: not an admin, so never the
    // admin login — the owner login, with a reason.
    return "We couldn't find an account for this sign-in. Contact support if you think this is a mistake.";
  }
  if (errorParam === 'session_expired') {
    // Emitted by /onboarding/payment-success when the Supabase session lapsed
    // during the Stripe round-trip. The owner has just paid — say so, or the
    // bare login form reads as "the payment failed".
    return 'Your session expired during checkout. Sign in to continue setup. Your payment is safe.';
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
