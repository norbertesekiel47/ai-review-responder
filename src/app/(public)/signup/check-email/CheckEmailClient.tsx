'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

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
  const prefilledEmail = searchParams.get('email') ?? '';

  const [email, setEmail] = useState(prefilledEmail);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');

  const [resendEmail, setResendEmail] = useState(prefilledEmail);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setVerifyError('');
    setVerifying(true);
    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          token: code.trim(),
        }),
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

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    setResendLoading(true);
    try {
      await fetch('/api/auth/resend-confirmation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: resendEmail.trim().toLowerCase(),
          flow: 'owner',
        }),
      });
      setResendSent(true);
    } catch {
      // No-enumeration policy: always show success even on connection failure.
      setResendSent(true);
    } finally {
      setResendLoading(false);
    }
  }

  const heading = fromLogin ? 'Almost there' : 'Check your email';
  const body = fromLogin
    ? 'Confirm your email to log in. We sent a 6-digit code to your inbox — enter it below.'
    : 'We sent a 6-digit code to your inbox. Enter it below to activate your account.';

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 p-8">
        <h1 className="text-2xl font-bold mb-2 text-center">{heading}</h1>
        <p className="text-gray-700 mb-6 text-center">{body}</p>

        <form onSubmit={handleVerify} className="space-y-3 mb-6">
          <div>
            <label htmlFor="verify-email" className="sr-only">
              Email
            </label>
            <input
              id="verify-email"
              type="email"
              autoComplete="email"
              required
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="verify-code" className="sr-only">
              Confirmation code
            </label>
            <input
              id="verify-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              minLength={4}
              maxLength={10}
              pattern="[A-Za-z0-9]+"
              placeholder="6-digit code"
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

        <div className="border-t border-gray-200 pt-4">
          <p className="text-xs text-gray-500 text-center mb-3">
            Didn&apos;t get a code? Check your spam folder. Codes expire in
            24 hours.
          </p>
          {resendSent ? (
            <p className="text-sm text-green-700 text-center">
              A new code is on its way.
            </p>
          ) : (
            <form onSubmit={handleResend} className="space-y-2">
              <input
                type="email"
                required
                placeholder="Your email"
                value={resendEmail}
                onChange={(e) => setResendEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
              <button
                type="submit"
                disabled={resendLoading}
                className="w-full bg-gray-100 text-gray-700 font-medium py-2 rounded-md text-sm hover:bg-gray-200 disabled:opacity-50"
              >
                {resendLoading ? 'Sending...' : 'Resend code'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
