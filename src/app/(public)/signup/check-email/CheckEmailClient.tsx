'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

export function CheckEmailClient() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <CheckEmailInner />
    </Suspense>
  );
}

function CheckEmailInner() {
  const searchParams = useSearchParams();
  const fromLogin = searchParams.get('from') === 'login';

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch('/api/auth/resend-confirmation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          flow: 'owner',
        }),
      });
      setSent(true);
    } catch {
      // No-enumeration policy: always show the same success message even on
      // connection failure. Resend API is best-effort on the client.
      setSent(true);
    } finally {
      setLoading(false);
    }
  }

  const heading = fromLogin ? 'Almost there' : 'Check your email';
  const body = fromLogin
    ? 'Confirm your email to log in. We sent a link to your inbox — click it to activate your account.'
    : 'We sent a confirmation link to your inbox. Click it to activate your account and proceed to payment.';

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 p-8 text-center">
        <h1 className="text-2xl font-bold mb-4">{heading}</h1>
        <p className="text-gray-700 mb-6">{body}</p>
        <p className="text-sm text-gray-500 mb-6">
          Check your spam folder if you don&apos;t see it. The link expires in
          24 hours.
        </p>
        {sent ? (
          <p className="text-sm text-green-700">
            A new confirmation link is on its way.
          </p>
        ) : (
          <form onSubmit={handleResend} className="space-y-3">
            <input
              type="email"
              required
              placeholder="Your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gray-100 text-gray-700 font-medium py-2 rounded-md text-sm hover:bg-gray-200 disabled:opacity-50"
            >
              {loading ? 'Sending...' : 'Resend confirmation email'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
