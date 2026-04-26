'use client';

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import type { AuthFlow } from '@/lib/shared/auth-flow';

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

const OWNER_ALLOWED_PREFIXES = ['/dashboard', '/settings', '/onboarding'] as const;
const ADMIN_AUTH_PAGES = ['/admin/login', '/admin/forgot-password', '/admin/reset-password'] as const;

function resolvePostLoginDestination(
  portal: AuthFlow,
  from: string,
  defaultRoute: string,
): string {
  // Must be an absolute internal path, not a protocol-relative URL.
  if (!from.startsWith('/') || from.startsWith('//')) {
    return defaultRoute;
  }

  if (portal === 'owner') {
    const allowed = OWNER_ALLOWED_PREFIXES.some((prefix) => from.startsWith(prefix));
    return allowed ? from : defaultRoute;
  }

  // Admin portal: accept /admin/* except the auth pages themselves (would loop).
  if (!from.startsWith('/admin')) {
    return defaultRoute;
  }
  const isAuthPage = ADMIN_AUTH_PAGES.some((page) => from === page || from.startsWith(`${page}/`));
  return isAuthPage ? defaultRoute : from;
}

function LoginFormInner({
  portal,
  brandName,
  showGoogleButton,
  defaultRoute,
  allowedRoles,
}: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const searchParams = useSearchParams();
  const router = useRouter();

  const errorParam = searchParams.get('error');
  const initialError =
    errorParam === 'account_incomplete'
      ? 'Your account is not set up yet. Contact your administrator.'
      : errorParam === 'auth_callback_failed'
        ? 'Sign-in failed. Please try again.'
        : '';
  const [error, setError] = useState(initialError);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const { error: authError, data } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });

      if (authError) {
        // Email-not-confirmed UX: route to check-email page instead of raw error.
        if (authError.message.toLowerCase().includes('email not confirmed')) {
          const emailParam = encodeURIComponent(email.trim().toLowerCase());
          router.push(`/signup/check-email?from=login&email=${emailParam}`);
          return;
        }
        setError(authError.message);
        return;
      }

      const authId = data?.user?.id;
      let role: string | null = null;
      if (authId) {
        const { data: userRow } = await supabase
          .from('users')
          .select('role')
          .eq('auth_id', authId)
          .limit(1)
          .single();
        role = (userRow as { role: string } | null)?.role ?? null;
      }

      if (!role || !allowedRoles.includes(role)) {
        await supabase.auth.signOut();
        setError(
          portal === 'owner'
            ? 'That account is for the admin portal. Use /admin/login instead.'
            : 'That account is for the owner portal. Use /login instead.',
        );
        return;
      }

      // Owner post-login routing must honor subscription lifecycle:
      // - pending_payment → /onboarding/pay (dashboard would show a stub)
      // - active + !businessOnboarded → /onboarding/business (must finish
      //   the wizard before the dashboard has anything to show)
      // - active + businessOnboarded / past_due / cancelled → standard
      //   dashboard routing (banners handle the latter two)
      // Admin portal has no subscription context — skip the check.
      let destinationOverride: string | null = null;
      if (portal === 'owner') {
        try {
          const statusRes = await fetch('/api/auth/signup-status');
          if (statusRes.ok) {
            const status = (await statusRes.json()) as {
              subscriptionStatus?: string;
              businessOnboarded?: boolean;
            };
            if (status.subscriptionStatus === 'pending_payment') {
              destinationOverride = '/onboarding/pay';
            } else if (
              status.subscriptionStatus === 'active' &&
              status.businessOnboarded === false
            ) {
              destinationOverride = '/onboarding/business';
            }
          }
        } catch {
          // Soft-fail — fall back to default routing. A transient status
          // fetch error shouldn't block login; the dashboard's own guards
          // will catch pending_payment / pending-onboarding owners on the
          // next page load.
        }
      }

      const from = searchParams.get('from') ?? '';
      const destination =
        destinationOverride ??
        resolvePostLoginDestination(portal, from, defaultRoute);
      router.push(destination);
      router.refresh();
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    const supabase = createBrowserSupabaseClient();
    const redirectTo = `${window.location.origin}/api/auth/callback?flow=${portal}&next=${defaultRoute}`;
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
  }

  const forgotPath =
    portal === 'owner' ? '/forgot-password' : '/admin/forgot-password';

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
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
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
          {error && <p className="text-sm text-red-600">{error}</p>}
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
              onClick={handleGoogle}
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
