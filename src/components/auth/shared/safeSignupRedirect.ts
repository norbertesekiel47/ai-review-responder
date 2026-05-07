// Defense-in-depth validator for the redirectTo value returned by
// /api/auth/signup. The endpoint is internal, but we never want a
// future bug, response-injection, or compromised upstream to redirect
// the browser to an arbitrary path. Mirrors how resolvePostLoginDestination
// validates the ?from= query parameter for sign-in.

const FALLBACK = '/signup/check-email';
const ALLOWED_PATHNAMES = [
  '/signup/check-email',
  '/signup/finish',
  '/onboarding/pay',
] as const;

export function safeSignupRedirect(value: unknown): string {
  if (typeof value !== 'string') return FALLBACK;
  if (!value.startsWith('/') || value.startsWith('//')) return FALLBACK;
  const pathname = value.split(/[?#]/)[0];
  return ALLOWED_PATHNAMES.some((p) => pathname === p) ? value : FALLBACK;
}
