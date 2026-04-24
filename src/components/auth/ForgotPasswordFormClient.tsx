'use client';

import { useState } from 'react';
import type { AuthFlow } from '@/lib/shared/auth-flow';

export interface ForgotPasswordFormProps {
  portal: AuthFlow;
  brandName: string;
}

export function ForgotPasswordFormClient({
  portal,
  brandName,
}: ForgotPasswordFormProps) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          role: portal,
        }),
      });
      setSent(true);
    } catch {
      // No-enumeration policy: always show the same success message even on
      // connection failure. The API is best-effort on the client side; any
      // hard failure still surfaces as the generic "if an account exists"
      // message. Logging could go here in the future.
      setSent(true);
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 p-6 text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-4">{brandName}</h1>
          <p className="text-sm text-gray-700">
            If an account exists for that email, we&apos;ve sent a reset link.
            Check your inbox.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">
          {brandName}
        </h1>
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg border border-gray-200 p-6 space-y-4"
        >
          <h2 className="text-base font-medium text-gray-900">
            Reset your password
          </h2>
          <div>
            <label
              htmlFor="forgot-email"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Email
            </label>
            <input
              id="forgot-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Sending...' : 'Send reset link'}
          </button>
        </form>
      </div>
    </div>
  );
}
