'use client';

import { Suspense, useReducer } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { redirectAfterServerSessionCookie } from './CheckEmailClient.helpers';
import { AuthCardShell, authFieldClass, authPrimaryButtonClass } from './AuthCardShell';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { EMAIL_OTP_LENGTH, EMAIL_OTP_PATTERN } from '@/lib/shared/schemas';

interface CheckEmailState {
  code: string;
  verifying: boolean;
  verifyError: string;
  resendLoading: boolean;
  resendSent: boolean;
  resendError: string;
}

const initialCheckEmailState: CheckEmailState = {
  code: '',
  verifying: false,
  verifyError: '',
  resendLoading: false,
  resendSent: false,
  resendError: '',
};

type CheckEmailAction =
  | { type: 'setCode'; code: string }
  | { type: 'clearVerifyError' }
  | { type: 'setVerifying'; verifying: boolean }
  | { type: 'setVerifyError'; verifyError: string }
  | { type: 'resendStart' }
  | { type: 'setResendError'; resendError: string }
  | { type: 'resendSuccess' }
  | { type: 'resendFinish' };

function checkEmailReducer(state: CheckEmailState, action: CheckEmailAction): CheckEmailState {
  switch (action.type) {
    case 'setCode':
      return { ...state, code: action.code };
    case 'clearVerifyError':
      return { ...state, verifyError: '' };
    case 'setVerifying':
      return { ...state, verifying: action.verifying };
    case 'setVerifyError':
      return { ...state, verifyError: action.verifyError };
    case 'resendStart':
      return { ...state, resendLoading: true, resendError: '' };
    case 'setResendError':
      return { ...state, resendError: action.resendError };
    case 'resendSuccess':
      return { ...state, resendSent: true };
    case 'resendFinish':
      return { ...state, resendLoading: false };
  }
}

export function CheckEmailClient() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#D2E0D3]" />}>
      <CheckEmailInner />
    </Suspense>
  );
}

function CheckEmailInner() {
  const searchParams = useSearchParams();
  const fromLogin = searchParams.get('from') === 'login';
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  const [state, dispatch] = useReducer(checkEmailReducer, initialCheckEmailState);
  const { code, verifying, verifyError, resendLoading, resendSent, resendError } = state;

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    dispatch({ type: 'clearVerifyError' });
    // Guard against a missing email — happens when someone lands on
    // /signup/check-email without the ?email= query param (bookmark, manual
    // URL edit, etc.). Without this the POST fires with email='' and the
    // server returns a generic 400 invalid_body that maps to "Verification
    // failed. Please try again." — useless for the user. Surface a clear
    // dead-end message + skip the wasted round-trip.
    if (!email) {
      dispatch({
        type: 'setVerifyError',
        verifyError: 'No email on this page — please go back and start signup again.',
      });
      return;
    }
    dispatch({ type: 'setVerifying', verifying: true });
    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, token: code.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        dispatch({
          type: 'setVerifyError',
          verifyError:
            body.error === 'invalid_or_expired_code'
              ? 'That code is invalid or has expired. Try again or resend.'
              : body.error === 'rate_limited'
                ? 'Too many attempts. Wait a few minutes and try again.'
                : 'Verification failed. Please try again.',
        });
        return;
      }
      // verify-otp writes the Supabase session through Set-Cookie. Use a
      // document navigation so the next protected request definitely carries
      // the fresh cookies instead of racing an app-router transition.
      redirectAfterServerSessionCookie(body.redirectTo);
    } catch {
      dispatch({ type: 'setVerifyError', verifyError: 'Connection failed. Please try again.' });
    } finally {
      dispatch({ type: 'setVerifying', verifying: false });
    }
  }

  async function handleResend() {
    if (resendLoading) return;
    // Same guard as handleVerify — but this branch ALSO reports the error
    // visibly. The button's `disabled` attr usually keeps users from
    // clicking when email is empty, but a programmatic call (devtools,
    // automated test, missing query param + cache state) could still land
    // here, and silently no-op'ing leaves the user staring at a button
    // that "works" but does nothing.
    if (!email) {
      dispatch({
        type: 'setResendError',
        resendError: 'No email on this page — please go back and start signup again.',
      });
      return;
    }
    dispatch({ type: 'resendStart' });
    try {
      const res = await fetch('/api/auth/resend-confirmation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, flow: 'owner' }),
      });
      if (res.status === 429) {
        dispatch({ type: 'setResendError', resendError: 'Too many resend attempts. Please wait a while.' });
        return;
      }
      dispatch({ type: 'resendSuccess' });
    } catch {
      // No-enumeration policy: show success even on connection failure.
      dispatch({ type: 'resendSuccess' });
    } finally {
      dispatch({ type: 'resendFinish' });
    }
  }

  const heading = fromLogin ? 'Almost there' : 'Check your email';
  // OTP length is driven by EMAIL_OTP_LENGTH (single source of truth). The
  // Supabase Auth → "Email OTP Length" setting MUST match it (6). Change the
  // constant + the Supabase setting in lockstep; nothing here is hardcoded.
  const subtext = fromLogin
    ? `Confirm your email to log in. We sent a ${EMAIL_OTP_LENGTH}-digit code to your inbox.`
    : `We sent a ${EMAIL_OTP_LENGTH}-digit code to your inbox. Enter it below to activate your account.`;

  return (
    <AuthCardShell>
      <h1 className="text-2xl font-semibold text-[#2a2a2a] mb-2 text-center">{heading}</h1>
      <p className="text-[#6a6a6a] mb-1 text-center">{subtext}</p>
      {email && (
        <p className="text-sm text-[#6a6a6a] mb-6 text-center">
          Sent to <span className="font-medium text-[#2a2a2a]">{email}</span>
        </p>
      )}

      <form onSubmit={handleVerify} className="space-y-3 mb-6">
        <div>
          <label htmlFor="verify-code" className="sr-only">
            Confirmation code
          </label>
          {/*
            All length constraints derive from EMAIL_OTP_LENGTH (single source
            of truth; keep it in lockstep with the Supabase "Email OTP Length"
            setting). minLength + maxLength + numeric pattern give browser-native
            validation feedback before submit. Server-side `VerifyEmailOtpSchema`
            stays defensively at 4–10 (Supabase's verifyOtp is the real
            validator).
          */}
          <input
            id="verify-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            minLength={EMAIL_OTP_LENGTH}
            maxLength={EMAIL_OTP_LENGTH}
            pattern={EMAIL_OTP_PATTERN}
            title={`Enter the ${EMAIL_OTP_LENGTH}-digit code from your email`}
            placeholder={`${EMAIL_OTP_LENGTH}-digit code`}
            value={code}
            onChange={(e) => dispatch({ type: 'setCode', code: e.target.value })}
            className={`${authFieldClass} text-center tracking-[0.5em] font-mono`}
          />
        </div>
        {verifyError && (
          <p className="text-sm text-red-600">{verifyError}</p>
        )}
        <button
          type="submit"
          disabled={verifying}
          className={authPrimaryButtonClass}
        >
          {verifying ? 'Verifying...' : 'Verify and continue'}
        </button>
      </form>

      <LiveRegion level="assertive" message={verifyError} />
      <LiveRegion level="assertive" message={resendError} />
      <LiveRegion message={resendSent ? 'A new code is on its way.' : ''} />

      <div className="border-t border-[#2a2a2a]/10 pt-4 space-y-3 text-center">
        <p className="text-xs text-[#6a6a6a]">
          Didn&apos;t get a code? Check your spam folder. Codes expire in 24
          hours.
        </p>
        {resendSent ? (
          <p className="text-sm text-[#2a2a2a]">A new code is on its way.</p>
        ) : resendError ? (
          <p className="text-sm text-red-600">{resendError}</p>
        ) : (
          <button
            type="button"
            onClick={handleResend}
            disabled={resendLoading || !email}
            className="text-sm text-[#97B3AE] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {resendLoading ? 'Sending…' : 'Resend code'}
          </button>
        )}
        <div>
          <Link
            href="/signup"
            className="text-sm text-[#6a6a6a] hover:text-[#2a2a2a] hover:underline"
          >
            ← Go back and change email
          </Link>
        </div>
      </div>
    </AuthCardShell>
  );
}
