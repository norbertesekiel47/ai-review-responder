export const UNSUPPORTED_ROLE_MESSAGE =
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

export function mapSupabaseAuthError(message: string): string {
  if (message === 'Invalid login credentials') {
    return 'Email or password is incorrect.';
  }
  return message;
}

export function isEmailNotConfirmedError(message: string): boolean {
  return message.toLowerCase().includes('email not confirmed');
}
