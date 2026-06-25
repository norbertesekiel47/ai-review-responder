'use client';

import { Suspense, useEffect, useReducer, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { redirectAfterServerSessionCookie } from './CheckEmailClient.helpers';
import { AuthCardShell, authFieldClass, authPrimaryButtonClass } from './AuthCardShell';
import { CHECK_EMAIL_EMAIL_KEY } from './shared/prefillEmail';
import { fetchWithTimeout } from './shared/fetchWithTimeout';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { EMAIL_OTP_LENGTH, EMAIL_OTP_PATTERN } from '@/lib/shared/schemas';

interface CheckEmailState {
  code: string;
  verifying: boolean;
  verifyError: string;
  resendLoading: boolean;
  resendSent: boolean;
  resendError: string;
  // True for a short window after a successful resend. Keeps the resend button
  // visible (just disabled) so a SECOND resend is possible — instead of
  // permanently swapping the button out for static text.
  resendCooldown: boolean;
}

const initialCheckEmailState: CheckEmailState = {
  code: '',
  verifying: false,
  verifyError: '',
  resendLoading: false,
  resendSent: false,
  resendError: '',
  resendCooldown: false,
};

type CheckEmailAction =
  | { type: 'setCode'; code: string }
  | { type: 'clearVerifyError' }
  | { type: 'setVerifying'; verifying: boolean }
  | { type: 'setVerifyError'; verifyError: string }
  | { type: 'resendStart' }
  | { type: 'setResendError'; resendError: string }
  | { type: 'resendSuccess' }
  | { type: 'resendCooldownEnd' }
  | { type: 'resendFinish' };

// Flat one-case-per-action switch; cyclomatic count is the action vocabulary.
// fallow-ignore-next-line complexity
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
      return { ...state, resendSent: true, resendCooldown: true };
    case 'resendCooldownEnd':
      return { ...state, resendCooldown: false };
    case 'resendFinish':
      return { ...state, resendLoading: false };
  }
}

export function CheckEmailClient() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-rw-sage" />}>
      <CheckEmailInner />
    </Suspense>
  );
}

// Single-screen OTP form: branches are independent UI states (verify/resend/
// cooldown/error), not nested logic.
// fallow-ignore-next-line complexity
function CheckEmailInner() {
  const searchParams = useSearchParams();
  const fromLogin = searchParams.get('from') === 'login';
  // Email source precedence: an explicit ?email= param (server signup/pay
  // redirects, which can't write sessionStorage) wins; otherwise fall back to
  // sessionStorage, which the client login path uses so the email never leaks
  // into the URL/history/referrer/logs.
  const paramEmail = (searchParams.get('email') ?? '').trim().toLowerCase();
  const [email, setEmail] = useState(paramEmail);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (paramEmail) {
      sessionStorage.removeItem(CHECK_EMAIL_EMAIL_KEY);
      return;
    }
    const stored = sessionStorage.getItem(CHECK_EMAIL_EMAIL_KEY);
    if (stored) {
      // sessionStorage is browser-only (undefined during SSR), so this read
      // can't be a lazy initializer — it must happen in an effect (same pattern
      // as LoginForm's PREFILL_EMAIL_KEY handoff).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEmail(stored.trim().toLowerCase());
      sessionStorage.removeItem(CHECK_EMAIL_EMAIL_KEY);
    }
  }, [paramEmail]);

  const [state, dispatch] = useReducer(checkEmailReducer, initialCheckEmailState);
  const { code, verifying, verifyError, resendLoading, resendSent, resendError, resendCooldown } =
    state;

  // Track the resend-cooldown timer so it can be cleared on unmount (and before
  // re-arming) — otherwise a pending dispatch can fire after the component leaves.
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
    },
    [],
  );

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
      const res = await fetchWithTimeout('/api/auth/verify-otp', {
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
    if (resendLoading || resendCooldown) return;
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
      const res = await fetchWithTimeout('/api/auth/resend-confirmation', {
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
    // Lift the cooldown after a short window so a second resend stays possible.
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
    cooldownTimerRef.current = setTimeout(() => dispatch({ type: 'resendCooldownEnd' }), 20_000);
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
      <h1 className="text-2xl font-semibold text-rw-ink mb-2 text-center">{heading}</h1>
      <p className="text-rw-ink-soft mb-1 text-center">{subtext}</p>
      {email && (
        <p className="text-sm text-rw-ink-soft mb-6 text-center">
          Sent to <span className="font-medium text-rw-ink">{email}</span>
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
        {/* aria-hidden — the assertive LiveRegion below is the sole announcer,
            so AT hears the verify error exactly once. */}
        {verifyError && (
          <p className="text-sm text-rw-error" aria-hidden="true">
            {verifyError}
          </p>
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

      <div className="border-t border-rw-ink/10 pt-4 space-y-3 text-center">
        <p className="text-xs text-rw-ink-soft">
          Didn&apos;t get a code? Check your spam folder. Codes expire in 24
          hours.
        </p>
        {/* Confirmation + error copy are aria-hidden — the two LiveRegions above
            own announcements. The resend button is ALWAYS rendered (just
            disabled during load/cooldown) so a second resend stays possible
            instead of the button being permanently swapped out. */}
        {resendSent && !resendCooldown && (
          <p className="text-sm text-rw-success" aria-hidden="true">
            A new code is on its way.
          </p>
        )}
        {resendError && (
          <p className="text-sm text-rw-error" aria-hidden="true">
            {resendError}
          </p>
        )}
        <button
          type="button"
          onClick={handleResend}
          disabled={resendLoading || resendCooldown || !email}
          className="text-sm text-rw-teal-strong hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {resendLoading
            ? 'Sending…'
            : resendCooldown
              ? 'Code sent — resend shortly'
              : 'Resend code'}
        </button>
        <div>
          <Link
            href="/signup"
            className="text-sm text-rw-ink-soft hover:text-rw-ink hover:underline"
          >
            ← Go back and change email
          </Link>
        </div>
      </div>
    </AuthCardShell>
  );
}
