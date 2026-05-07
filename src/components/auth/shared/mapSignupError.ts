export type SignupErrorKind =
  | 'rate_limited'
  | 'rate_limit_unavailable'
  | 'email_rate_limited'
  | 'account_exists'
  | 'invalid_json'
  | 'invalid_body'
  | 'internal'
  | 'unknown';

export interface MappedSignupError {
  kind: SignupErrorKind;
  message: string;
}

const KNOWN_MESSAGES: Record<Exclude<SignupErrorKind, 'unknown'>, string> = {
  rate_limited:
    'Too many signup attempts from your network. Please wait a few minutes and try again.',
  rate_limit_unavailable:
    'Signup is temporarily unavailable. Please try again in a moment.',
  email_rate_limited:
    'Too many signup attempts for this email recently. Please wait a few minutes and try again.',
  account_exists:
    'An account with that email already exists. Try signing in.',
  invalid_json:
    'Could not read your submission. Please try again.',
  invalid_body:
    "Some details don't look right. Please review and resubmit.",
  internal:
    'Something went wrong on our side. Please try again shortly.',
};

export function mapSignupError(
  body: { error?: unknown; message?: unknown },
  _status: number,
): MappedSignupError {
  const code = typeof body?.error === 'string' ? body.error : undefined;
  const serverMessage = typeof body?.message === 'string' ? body.message : undefined;
  const kind: SignupErrorKind =
    code && code in KNOWN_MESSAGES ? (code as SignupErrorKind) : 'unknown';
  const fallback = kind === 'unknown' ? KNOWN_MESSAGES.internal : KNOWN_MESSAGES[kind];
  return { kind, message: serverMessage ?? fallback };
}
