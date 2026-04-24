'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type FormState = {
  ownerName: string;
  ownerPhone: string;
  businessName: string;
  googleMapsUrl: string;
  productsServices: string;
  staffNames: string;
  highlightFacts: string;
  avoidFacts: string;
  sampleResponses: string;
  subscriptionTier: 'founding' | 'standard';
};

interface FinishSignupClientProps {
  defaultEmail: string;
  defaultName: string;
}

export function FinishSignupClient({
  defaultEmail,
  defaultName,
}: FinishSignupClientProps) {
  const [form, setForm] = useState<FormState>({
    ownerName: defaultName,
    ownerPhone: '',
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
      const res = await fetch('/api/auth/finish-signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Submission failed');
        return;
      }
      router.push(body.redirectTo ?? '/onboarding/pay');
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
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
        <h1 className="text-2xl font-bold text-center mb-2">
          Almost there &mdash; tell us about your business
        </h1>
        <p className="text-center text-gray-600 mb-8">
          We just need a few details to set up your account.
        </p>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg border border-gray-200 p-6 space-y-4"
        >
          <fieldset className="space-y-3">
            <legend className="font-medium">Your details</legend>
            <input
              type="email"
              disabled
              value={defaultEmail}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-gray-100 text-gray-600"
            />
            <input
              type="text"
              required
              placeholder="Your name"
              value={form.ownerName}
              onChange={onChange('ownerName')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <input
              type="tel"
              placeholder="Phone (optional)"
              value={form.ownerPhone}
              onChange={onChange('ownerPhone')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="font-medium">Your business</legend>
            <input
              type="text"
              required
              placeholder="Business name"
              value={form.businessName}
              onChange={onChange('businessName')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <input
              type="url"
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
            {loading ? 'Submitting...' : 'Continue to payment'}
          </button>
        </form>
      </div>
    </div>
  );
}
