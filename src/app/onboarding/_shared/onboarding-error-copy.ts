// Owner-facing copy for the onboarding API error codes.
//
// `/api/onboarding/start` and `/api/onboarding/business` answer failures with a
// machine code in `error` (`invalid_body`, `rate_limited`, …). Those codes are
// for logs and tests; an owner must never read one off a red banner. Every
// code the two routes emit is mapped here, and anything unmapped — a new code,
// a proxy error page, an empty body — falls back to one plain sentence.
// Modelled on `FINISH_SIGNUP_ERROR_COPY` (FinishSignupClient.tsx).

export const ONBOARDING_ERROR_FALLBACK =
  'Something went wrong on our side. Please try again shortly.';

export const ONBOARDING_CONNECTION_FAILED =
  "Couldn't reach RepWorth. Check your connection and try again.";

const SESSION_EXPIRED = 'Your session has expired. Please sign in again.';

export const ONBOARDING_ERROR_COPY: Record<string, string> = {
  invalid_body: "Some details don't look right. Please check them and try again.",
  invalid_json: "Couldn't read your details. Please try again.",
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
  rate_limit_unavailable: 'Setup is temporarily unavailable. Please try again in a moment.',
  redis_unavailable: 'Setup is temporarily unavailable. Please try again in a moment.',
  unauthorized: SESSION_EXPIRED,
  account_incomplete: SESSION_EXPIRED,
  forbidden: "We couldn't verify this request. Please reload the page and try again.",
  not_found: 'This page is not available right now.',
  subscription_inactive:
    'Your subscription is not active yet. Finish checkout, or contact support if you already paid.',
  onboarding_not_started: 'Start by finding your business, then come back to this step.',
  already_onboarded: 'Your business is already set up. Head to your dashboard.',
  internal: ONBOARDING_ERROR_FALLBACK,
};

/**
 * Map a non-OK onboarding API response body to owner copy. Reads only the
 * `error` code; a server `message` field is never surfaced, so no raw
 * server text can reach the screen.
 */
export function mapOnboardingApiError(body: unknown): string {
  const code =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error?: unknown }).error
      : undefined;
  return (typeof code === 'string' && ONBOARDING_ERROR_COPY[code]) || ONBOARDING_ERROR_FALLBACK;
}
