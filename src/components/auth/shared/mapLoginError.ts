export function mapInitialQueryError(errorParam: string | null | undefined): string {
  if (errorParam === 'account_incomplete') {
    return 'Your account is not set up yet. Contact your administrator.';
  }
  if (errorParam === 'auth_callback_failed') {
    return 'Sign-in failed. Please try again.';
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
