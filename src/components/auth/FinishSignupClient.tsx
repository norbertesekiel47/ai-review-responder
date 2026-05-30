'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LiveRegion } from '@/components/ui/LiveRegion';

type FormState = {
  ownerName: string;
  ownerPhone: string;
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
        body: JSON.stringify({
          ownerName: form.ownerName,
          ownerPhone: form.ownerPhone || undefined,
        }),
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
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [k]: e.target.value });

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-sm mx-auto">
        <h1 className="text-2xl font-bold text-center mb-2">
          Almost there — just your name
        </h1>
        <p className="text-center text-gray-600 mb-8">
          We&apos;ll set up your business after payment.
        </p>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg border border-gray-200 p-6 space-y-4"
        >
          <div>
            <label htmlFor="finish-email" className="block text-sm font-medium text-gray-700 mb-1">
              Email (from your Google account)
            </label>
            <input
              id="finish-email"
              type="email"
              autoComplete="email"
              disabled
              value={defaultEmail}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-gray-100 text-gray-600"
            />
          </div>
          <div>
            <label htmlFor="finish-name" className="block text-sm font-medium text-gray-700 mb-1">
              Your name
            </label>
            <input
              id="finish-name"
              type="text"
              autoComplete="name"
              required
              value={form.ownerName}
              onChange={onChange('ownerName')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="finish-phone" className="block text-sm font-medium text-gray-700 mb-1">
              Phone (optional)
            </label>
            <input
              id="finish-phone"
              type="tel"
              autoComplete="tel"
              value={form.ownerPhone}
              onChange={onChange('ownerPhone')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
          <LiveRegion level="assertive" message={error} />

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-3 rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Submitting...' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
