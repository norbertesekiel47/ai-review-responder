'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LiveRegion } from '@/components/ui/LiveRegion';
import {
  AuthCardShell,
  authFieldClass,
  authLabelClass,
  authPrimaryButtonClass,
} from './AuthCardShell';

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
    <AuthCardShell width="sm">
      <h1 className="text-2xl font-semibold text-[#2a2a2a] text-center mb-2">
        Almost there, just your name
      </h1>
      <p className="text-center text-[#6a6a6a] mb-8">
        We&apos;ll set up your business after payment.
      </p>

      <form
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <div>
          <label htmlFor="finish-email" className={authLabelClass}>
            Email (from your Google account)
          </label>
          <input
            id="finish-email"
            type="email"
            autoComplete="email"
            disabled
            value={defaultEmail}
            // Display-only: the email is fixed to the Google account. The
            // field stays `disabled` (not `readOnly`); the no-op onChange just
            // makes it a formally controlled input.
            onChange={() => undefined}
            className={`${authFieldClass} bg-[#F0EEEA] text-[#6a6a6a]`}
          />
        </div>
        <div>
          <label htmlFor="finish-name" className={authLabelClass}>
            Your name
          </label>
          <input
            id="finish-name"
            type="text"
            autoComplete="name"
            required
            value={form.ownerName}
            onChange={onChange('ownerName')}
            className={authFieldClass}
          />
        </div>
        <div>
          <label htmlFor="finish-phone" className={authLabelClass}>
            Phone (optional)
          </label>
          <input
            id="finish-phone"
            type="tel"
            autoComplete="tel"
            value={form.ownerPhone}
            onChange={onChange('ownerPhone')}
            className={authFieldClass}
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <LiveRegion level="assertive" message={error} />

        <button
          type="submit"
          disabled={loading}
          className={authPrimaryButtonClass}
        >
          {loading ? 'Submitting...' : 'Continue'}
        </button>
      </form>
    </AuthCardShell>
  );
}
