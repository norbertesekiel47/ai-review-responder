'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

type FormState = {
  ownerEmail: string;
  ownerName: string;
  ownerPhone: string;
  password: string;
  businessName: string;
  googleMapsUrl: string;
  productsServices: string;
  staffNames: string;
  highlightFacts: string;
  avoidFacts: string;
  sampleResponses: string;
  subscriptionTier: 'founding' | 'standard';
};

export function SignupFormClient() {
  const [form, setForm] = useState<FormState>({
    ownerEmail: '',
    ownerName: '',
    ownerPhone: '',
    password: '',
    businessName: '',
    googleMapsUrl: '',
    productsServices: '',
    staffNames: '',
    highlightFacts: '',
    avoidFacts: '',
    sampleResponses: '',
    subscriptionTier: 'standard',
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
        body: JSON.stringify(form),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Signup failed');
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
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) =>
      setForm({ ...form, [k]: e.target.value });

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-xl mx-auto">
        <h1 className="text-3xl font-bold text-center mb-2">
          Sign up for RepWorth
        </h1>
        <p className="text-center text-gray-600 mb-8">
          Start responding to your Google reviews in minutes.
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
          <fieldset className="space-y-3">
            <legend className="font-medium">Your details</legend>
            <label htmlFor="signup-email" className="sr-only">Email</label>
            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              required
              placeholder="Email"
              value={form.ownerEmail}
              onChange={onChange('ownerEmail')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <label htmlFor="signup-name" className="sr-only">Your name</label>
            <input
              id="signup-name"
              type="text"
              autoComplete="name"
              required
              placeholder="Your name"
              value={form.ownerName}
              onChange={onChange('ownerName')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <label htmlFor="signup-phone" className="sr-only">Phone (optional)</label>
            <input
              id="signup-phone"
              type="tel"
              autoComplete="tel"
              placeholder="Phone (optional)"
              value={form.ownerPhone}
              onChange={onChange('ownerPhone')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <label htmlFor="signup-password" className="sr-only">Password</label>
            <input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              placeholder="Password (8+ chars)"
              value={form.password}
              onChange={onChange('password')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="font-medium">Your business</legend>
            <label htmlFor="signup-business-name" className="sr-only">Business name</label>
            <input
              id="signup-business-name"
              type="text"
              autoComplete="organization"
              required
              placeholder="Business name"
              value={form.businessName}
              onChange={onChange('businessName')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <label htmlFor="signup-google-maps-url" className="sr-only">Google Maps URL</label>
            <input
              id="signup-google-maps-url"
              type="url"
              autoComplete="url"
              required
              placeholder="Google Maps URL for your business"
              value={form.googleMapsUrl}
              onChange={onChange('googleMapsUrl')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <textarea
              placeholder="Products / services (optional)"
              value={form.productsServices}
              onChange={onChange('productsServices')}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <textarea
              placeholder="Staff names (one per line or comma-separated)"
              value={form.staffNames}
              onChange={onChange('staffNames')}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <textarea
              placeholder="Highlight facts (e.g. 'opened 2010')"
              value={form.highlightFacts}
              onChange={onChange('highlightFacts')}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <textarea
              placeholder="Avoid facts (e.g. 'we don't do delivery')"
              value={form.avoidFacts}
              onChange={onChange('avoidFacts')}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <textarea
              placeholder="Sample responses (optional) — paste 1-2 previous replies that sound like you"
              value={form.sampleResponses}
              onChange={onChange('sampleResponses')}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="font-medium">Plan</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="tier"
                value="founding"
                checked={form.subscriptionTier === 'founding'}
                onChange={onChange('subscriptionTier')}
              />
              Founding &mdash; $X/mo (limited time)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="tier"
                value="standard"
                checked={form.subscriptionTier === 'standard'}
                onChange={onChange('subscriptionTier')}
              />
              Standard &mdash; $Y/mo
            </label>
          </fieldset>

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
