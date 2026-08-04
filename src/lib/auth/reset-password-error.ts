import type { AuthError } from '@supabase/supabase-js';

export interface MappedUpdateUserError {
  status: number;
  body: { error: string };
  report?: {
    reason: 'update_user_unmapped_401' | 'update_user_unusable_status';
    providerCode: AuthError['code'];
    providerStatus: AuthError['status'];
  };
}

/**
 * Maps a Supabase `auth.updateUser` password-write failure to the HTTP
 * response `POST /api/auth/reset-password` should return, plus an optional
 * `reportCaughtError` call for genuinely unusual provider responses. Pure —
 * the caller owns the actual `reportCaughtError` invocation and the
 * `NextResponse.json` construction.
 *
 * Backstop for the AAL step-up gate: if the pre-check ever drifts from
 * GoTrue's own rule, `insufficient_aal` still surfaces as `mfa_required`
 * rather than falling into the generic password-validation copy.
 *
 * Every other provider error keeps its real status — flattening them all to
 * 400 is precisely what made an `insufficient_aal` 401 read as a password
 * validation failure and hid the underlying bug, and it also swallowed the
 * genuine 401 of a session that lapsed mid-request (which the client turns
 * into its expired-link state).
 *
 * Matched on `code` alone, not the message text: the message is provider
 * copy that can be reworded at any time, and a bare 401 here is more likely
 * a lapsed session than an AAL refusal now that the step-up gate exists.
 */
export function mapUpdateUserError(error: AuthError): MappedUpdateUserError {
  const { code, status, message } = error;
  if (code === 'insufficient_aal') {
    return { status: 403, body: { error: 'mfa_required' } };
  }

  // GoTrue's AuthRetryableFetchError carries status 0 for a failed fetch, and
  // Response rejects anything outside 200–599. Clamp to the old 400 default
  // rather than letting a transient network error throw out of the handler.
  const httpStatus =
    typeof status === 'number' && status >= 400 && status <= 599 ? status : 400;

  if (status === 401 || httpStatus !== status) {
    // A 401 that ISN'T insufficient_aal becomes the client's expired-link
    // state. If that's ever a misread AAL refusal, the user loops forever —
    // so make it visible rather than silent.
    return {
      status: httpStatus,
      body: { error: message },
      report: {
        reason: status === 401 ? 'update_user_unmapped_401' : 'update_user_unusable_status',
        providerCode: code,
        providerStatus: status,
      },
    };
  }

  return { status: httpStatus, body: { error: message } };
}
