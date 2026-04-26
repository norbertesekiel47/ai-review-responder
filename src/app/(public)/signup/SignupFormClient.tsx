'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

type FormState = {
  ownerEmail: string;
  ownerName: string;
  ownerPhone: string;
  password: string;
};

export function SignupFormClient() {
  const [form, setForm] = useState<FormState>({
    ownerEmail: '',
    ownerName: '',
    ownerPhone: '',
    password: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: form.ownerEmail,
          ownerName: form.ownerName,
          ownerPhone: form.ownerPhone || undefined,
          password: form.password,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        // Defense-in-depth client-side fallback. The API now sends a
        // `message` for every error code (rate_limited, rate_limit_unavailable,
        // email_rate_limited, account_exists, internal). If a future regression
        // ships a machine code without one, map known shapes here so the user
        // never sees `rate_limited` or similar verbatim.
        const KNOWN_MESSAGES: Record<string, string> = {
          rate_limited:
            'Too many signup attempts from your network. Please wait a few minutes and try again.',
          rate_limit_unavailable:
            'Signup is temporarily unavailable. Please try again in a moment.',
          email_rate_limited:
            'Too many signup attempts for this email recently. Please wait a few minutes and try again.',
          invalid_json: 'Could not read your submission. Please try again.',
          invalid_body: 'Some details don\'t look right. Please review and resubmit.',
          internal: 'Something went wrong on our side. Please try again shortly.',
        };
        const machineCode =
          typeof body.error === 'string' ? body.error : undefined;
        const fallback =
          (machineCode && KNOWN_MESSAGES[machineCode]) ?? 'Signup failed';
        setError(body.message ?? fallback);
        return;
      }
      router.push(body.redirectTo ?? '/signup/check-email');
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    const supabase = createBrowserSupabaseClient();
    const redirectTo = `${window.location.origin}/api/auth/callback?flow=owner&next=/signup/finish`;
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
  }

  const onChange =
    (k: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [k]: e.target.value });

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-sm mx-auto">
        <h1 className="text-3xl font-bold text-center mb-2">
          Sign up for RepWorth
        </h1>
        <p className="text-center text-gray-600 mb-8">
          Just three details to get started — we&apos;ll set up your business after
          payment.
        </p>

        <button
          type="button"
          onClick={handleGoogle}
          className="w-full mb-6 bg-white border border-gray-300 py-3 rounded-md font-medium hover:bg-gray-50"
        >
          Continue with Google
        </button>

        <div className="text-center text-sm text-gray-500 mb-6">
          or continue with email
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg border border-gray-200 p-6 space-y-4"
        >
          <div>
            <label htmlFor="signup-email" className="sr-only">
              Email
            </label>
            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              required
              placeholder="Email"
              value={form.ownerEmail}
              onChange={onChange('ownerEmail')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="signup-name" className="sr-only">
              Your name
            </label>
            <input
              id="signup-name"
              type="text"
              autoComplete="name"
              required
              placeholder="Your name"
              value={form.ownerName}
              onChange={onChange('ownerName')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="signup-phone" className="sr-only">
              Phone (optional)
            </label>
            <input
              id="signup-phone"
              type="tel"
              autoComplete="tel"
              placeholder="Phone (optional)"
              value={form.ownerPhone}
              onChange={onChange('ownerPhone')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="signup-password" className="sr-only">
              Password
            </label>
            <input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              placeholder="Password (8+ chars)"
              value={form.password}
              onChange={onChange('password')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-3 rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Creating account...' : 'Continue'}
          </button>

          <p className="text-xs text-gray-500 text-center">
            Already have an account?{' '}
            <a href="/login" className="text-blue-600 hover:underline">
              Log in
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
