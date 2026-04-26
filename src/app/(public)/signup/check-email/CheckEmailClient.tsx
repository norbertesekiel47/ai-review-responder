'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

export function CheckEmailClient() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <CheckEmailInner />
    </Suspense>
  );
}

function CheckEmailInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const fromLogin = searchParams.get('from') === 'login';
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');

  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [resendError, setResendError] = useState('');

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setVerifyError('');
    setVerifying(true);
    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, token: code.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        setVerifyError(
          body.error === 'invalid_or_expired_code'
            ? 'That code is invalid or has expired. Try again or resend.'
            : body.error === 'rate_limited'
              ? 'Too many attempts. Wait a few minutes and try again.'
              : 'Verification failed. Please try again.',
        );
        return;
      }
      router.push(body.redirectTo ?? '/onboarding/pay');
    } catch {
      setVerifyError('Connection failed. Please try again.');
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend() {
    if (resendLoading || !email) return;
    setResendLoading(true);
    setResendError('');
    try {
      const res = await fetch('/api/auth/resend-confirmation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, flow: 'owner' }),
      });
      if (res.status === 429) {
        setResendError('Too many resend attempts. Please wait a while.');
        return;
      }
      setResendSent(true);
    } catch {
      // No-enumeration policy: show success even on connection failure.
      setResendSent(true);
    } finally {
      setResendLoading(false);
    }
  }

  const heading = fromLogin ? 'Almost there' : 'Check your email';
  // Supabase Auth → Settings → "Email OTP Length" controls this — production
  // is configured to 8. If you change it there, also update this copy +
  // the `placeholder` below.
  const subtext = fromLogin
    ? 'Confirm your email to log in. We sent an 8-digit code to your inbox.'
    : 'We sent an 8-digit code to your inbox. Enter it below to activate your account.';

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 p-8">
        <h1 className="text-2xl font-bold mb-2 text-center">{heading}</h1>
        <p className="text-gray-700 mb-1 text-center">{subtext}</p>
        {email && (
          <p className="text-sm text-gray-500 mb-6 text-center">
            Sent to <span className="font-medium text-gray-700">{email}</span>
          </p>
        )}

        <form onSubmit={handleVerify} className="space-y-3 mb-6">
          <div>
            <label htmlFor="verify-code" className="sr-only">
              Confirmation code
            </label>
            <input
              id="verify-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              minLength={4}
              maxLength={10}
              pattern="[A-Za-z0-9]+"
              placeholder="8-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base text-center tracking-[0.5em] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {verifyError && (
            <p className="text-sm text-red-600">{verifyError}</p>
          )}
          <button
            type="submit"
            disabled={verifying}
            className="w-full bg-blue-600 text-white font-medium py-3 rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {verifying ? 'Verifying...' : 'Verify and continue'}
          </button>
        </form>

        <div className="border-t border-gray-200 pt-4 space-y-3 text-center">
          <p className="text-xs text-gray-500">
            Didn&apos;t get a code? Check your spam folder. Codes expire in 24
            hours.
          </p>
          {resendSent ? (
            <p className="text-sm text-green-700">A new code is on its way.</p>
          ) : resendError ? (
            <p className="text-sm text-red-600">{resendError}</p>
          ) : (
            <button
              type="button"
              onClick={handleResend}
              disabled={resendLoading || !email}
              className="text-sm text-blue-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {resendLoading ? 'Sending…' : 'Resend code'}
            </button>
          )}
          <div>
            <Link
              href="/signup"
              className="text-sm text-gray-500 hover:text-gray-700 hover:underline"
            >
              ← Go back and change email
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
