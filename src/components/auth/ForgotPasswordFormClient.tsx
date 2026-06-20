'use client';

import { useState } from 'react';
import Link from 'next/link';
import { type AuthFlow, loginUrlForFlow } from '@/lib/shared/auth-flow';
import {
  AuthCardShell,
  authFieldClass,
  authLabelClass,
  authPrimaryButtonClass,
} from './AuthCardShell';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { fetchWithTimeout } from '@/components/auth/shared/fetchWithTimeout';

// Single owner for the sent-state copy: used by both variants and the
// LiveRegion so the text can never drift between them.
const SENT_MESSAGE =
  "If an account exists for that email, we've sent a reset link. Check your inbox.";

export interface ForgotPasswordFormProps {
  portal: AuthFlow;
  brandName: string;
}

interface AdminForgotPasswordProps {
  brandName: string;
  email: string;
  setEmail: (v: string) => void;
  sent: boolean;
  loading: boolean;
  handleSubmit: (e: React.FormEvent) => Promise<void>;
}

/** Renders the unchanged utilitarian gray/blue card for the admin portal. */
function AdminForgotPassword({
  brandName,
  email,
  setEmail,
  sent,
  loading,
  handleSubmit,
}: AdminForgotPasswordProps) {
  if (sent) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 p-6 text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-4">{brandName}</h1>
          <p className="text-sm text-gray-700">{SENT_MESSAGE}</p>
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
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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

export function ForgotPasswordFormClient({
  portal,
  brandName,
}: ForgotPasswordFormProps) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  // Short cooldown after a (re)send so the "Resend" affordance can't be hammered.
  const [resendCoolingDown, setResendCoolingDown] = useState(false);

  async function sendResetEmail() {
    try {
      await fetchWithTimeout('/api/auth/forgot-password', {
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
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await sendResetEmail();
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendCoolingDown) return;
    setResendCoolingDown(true);
    await sendResetEmail();
    // Re-enable after a short window. The success copy never changes, so this
    // resend leaks nothing the first send didn't (no-enumeration preserved).
    window.setTimeout(() => setResendCoolingDown(false), 20_000);
  }

  if (portal === 'admin') {
    return (
      <AdminForgotPassword
        brandName={brandName}
        email={email}
        setEmail={setEmail}
        sent={sent}
        loading={loading}
        handleSubmit={handleSubmit}
      />
    );
  }

  return (
    <AuthCardShell width="sm">
      <LiveRegion message={sent ? SENT_MESSAGE : ''} />
      {sent ? (
        <div className="space-y-6 text-center">
          <p className="text-base text-[#2a2a2a]">{SENT_MESSAGE}</p>
          <div className="space-y-2 text-sm">
            <p className="text-[#6a6a6a]">
              Didn&apos;t get it?{' '}
              <button
                type="button"
                onClick={handleResend}
                disabled={resendCoolingDown}
                className="font-medium text-[#557069] hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
              >
                {resendCoolingDown ? 'Sent — check again shortly' : 'Resend'}
              </button>
            </p>
            <p>
              <Link
                href={loginUrlForFlow(portal)}
                className="font-medium text-[#557069] hover:underline"
              >
                ← Back to sign in
              </Link>
            </p>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <h1 className="text-2xl font-semibold text-[#2a2a2a]">Reset your password</h1>
          <div>
            <label htmlFor="forgot-email" className={authLabelClass}>Email</label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={authFieldClass}
            />
          </div>
          <button type="submit" disabled={loading} className={authPrimaryButtonClass}>
            {loading ? 'Sending...' : 'Send reset link'}
          </button>
        </form>
      )}
    </AuthCardShell>
  );
}
