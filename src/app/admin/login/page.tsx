'use client';

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

export default function AdminLoginPage() {
  return (
    <Suspense fallback={<LoginSkeleton />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginSkeleton() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">
          RepWorth Admin
        </h1>
        <div className="bg-white rounded-lg border border-gray-200 p-6 h-48 animate-pulse" />
      </div>
    </div>
  );
}

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawFrom = searchParams.get('from') ?? '';
  // Restrict `from` to safe internal paths only (no //, no external URLs).
  // We do NOT force `/admin/*` here — owners come through this page too,
  // and forcing /admin/overview for an owner causes a post-login redirect
  // loop (middleware rejects the owner from /admin/*). The role-aware
  // fallback below picks /dashboard vs /admin/overview when `from` is
  // missing or unsafe.
  const from =
    rawFrom.startsWith('/') && !rawFrom.startsWith('//') ? rawFrom : '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const supabase = createBrowserSupabaseClient();
      const { error: authError, data } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      // Session cookie is set automatically by @supabase/ssr. Decide where
      // to send the user:
      //   1. If `from` is a safe internal path AND the user's role can
      //      reach it → honor it.
      //   2. Otherwise → role-based default (owner → /dashboard,
      //      admin/sales_partner → /admin/overview).
      // Role is looked up via a tiny select on the users table keyed by
      // auth_id. If the lookup fails we fall back to the admin overview
      // (which middleware will redirect from if the role doesn't fit).
      let destination: string = from;
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

      const ownerDefault = '/dashboard';
      const adminDefault = '/admin/overview';
      const fromIsAdmin = from.startsWith('/admin');
      const fromIsOwner = from.startsWith('/dashboard') || from.startsWith('/settings');

      if (role === 'owner') {
        destination = fromIsOwner ? from : ownerDefault;
      } else if (role === 'admin' || role === 'sales_partner') {
        destination = fromIsAdmin ? from : adminDefault;
      } else {
        // Unknown / missing role — send admin default and let middleware
        // bounce back if wrong.
        destination = from || adminDefault;
      }

      router.push(destination);
      router.refresh(); // Force middleware to re-evaluate with new session
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">
          RepWorth Admin
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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
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
        </form>
      </div>
    </div>
  );
}
