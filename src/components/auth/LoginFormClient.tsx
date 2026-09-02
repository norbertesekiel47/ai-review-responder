'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AuthFlow } from '@/lib/shared/auth-flow';
import { useLoginSubmit } from '@/components/auth/hooks/useLoginSubmit';
import { useGoogleOAuth } from '@/components/auth/hooks/useGoogleOAuth';
import { mapInitialQueryError } from '@/components/auth/shared/mapLoginError';

const INPUT_BASE = 'w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:border-transparent';
const SUBMIT_BASE = 'w-full text-white font-medium py-2 rounded-md text-sm disabled:opacity-50 transition-colors';

/** Per-portal accent: the admin console is gray-900 throughout, so its sign-in door is too (X32). */
const ADMIN_THEME = {
  input: `${INPUT_BASE} focus:ring-gray-900`,
  submit: `${SUBMIT_BASE} bg-gray-900 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2`,
} as const;
const OWNER_THEME = {
  input: `${INPUT_BASE} focus:ring-blue-500`,
  submit: `${SUBMIT_BASE} bg-blue-600 hover:bg-blue-700`,
} as const;

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
  // The admin console's primary is gray-900 everywhere behind this door (X32);
  // a blue button and focus ring here were the only blue on the way in.
  const theme = portal === 'admin' ? ADMIN_THEME : OWNER_THEME;

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
              className={theme.input}
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
              className={theme.input}
            />
          </div>
          {displayError && <p className="text-sm text-red-600">{displayError}</p>}
          <button
            type="submit"
            disabled={loading}
            className={theme.submit}
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
