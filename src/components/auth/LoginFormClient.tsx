'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AuthFlow } from '@/lib/shared/auth-flow';
import { useLoginSubmit } from '@/components/auth/hooks/useLoginSubmit';
import { useGoogleOAuth } from '@/components/auth/hooks/useGoogleOAuth';
import { mapInitialQueryError } from '@/components/auth/shared/mapLoginError';

export interface LoginFormProps {
  portal: AuthFlow;
  brandName: string;
  showGoogleButton: boolean;
  defaultRoute: string;
  allowedRoles: readonly string[];
}

export function LoginFormClient(props: LoginFormProps) {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <LoginFormInner {...props} />
    </Suspense>
  );
}

// Exported for unit testing only. The public component is LoginFormClient,
// which wraps this in a Suspense boundary so useSearchParams() can resolve.
// Tests render LoginFormInner directly because renderToStaticMarkup runs
// outside an app/ context and would otherwise see only the Suspense fallback.
export function LoginFormInner({
  portal,
  brandName,
  showGoogleButton,
  defaultRoute,
  allowedRoles,
}: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const searchParams = useSearchParams();
  const { submit, loading, error, setError } = useLoginSubmit({
    portal,
    allowedRoles,
    defaultRoute,
  });
  const oauth = useGoogleOAuth({ flow: portal, next: defaultRoute });

  // Initial error from URL query string (account_incomplete, auth_callback_failed).
  // Read on each render so navigations within Suspense reflect updated params.
  const initialQueryError = mapInitialQueryError(searchParams.get('error'));
  const displayError = error || initialQueryError || oauth.error;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    await submit(email, password, searchParams.get('from') ?? '');
  }

  const forgotPath = portal === 'owner' ? '/forgot-password' : '/admin/forgot-password';

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">{brandName}</h1>
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg border border-gray-200 p-6 space-y-4"
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          {displayError && <p className="text-sm text-red-600">{displayError}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
          {showGoogleButton && (
            <button
              type="button"
              onClick={() => void oauth.start()}
              className="w-full bg-white border border-gray-300 text-gray-700 font-medium py-2 rounded-md text-sm hover:bg-gray-50 transition-colors"
            >
              Continue with Google
            </button>
          )}
          <p className="text-xs text-gray-500 text-center">
            <a href={forgotPath} className="hover:underline">
              Forgot password?
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
