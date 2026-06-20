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

// Curated, human-facing copy for the finish-signup server error codes. The
// route returns machine codes (`invalid_body`, `account_incomplete`, …) plus a
// few already-human `message` fields (`already_complete`, `account_exists`).
// Map codes to copy here so a raw code can never reach the UI; only fall back
// to a server `message` when it is one of those curated human strings.
const FINISH_SIGNUP_FALLBACK =
  'Something went wrong on our side. Please try again shortly.';

const FINISH_SIGNUP_ERROR_COPY: Record<string, string> = {
  account_exists:
    'An account with this email already exists. Try logging in or use forgot password.',
  already_complete: 'Your signup is already complete — try logging in.',
  invalid_body: "Some details don't look right. Please review and resubmit.",
  invalid_json: 'Could not read your submission. Please try again.',
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
  rate_limit_unavailable:
    'Signup is temporarily unavailable. Please try again in a moment.',
  unauthorized: 'Your session has expired. Please sign in again.',
  account_incomplete: 'Your session has expired. Please sign in again.',
  forbidden: 'We could not verify this request. Please reload and try again.',
  not_found: 'This page is not available right now.',
  internal: FINISH_SIGNUP_FALLBACK,
};

function mapFinishSignupError(body: { error?: unknown }): string {
  const code = typeof body?.error === 'string' ? body.error : undefined;
  return (code && FINISH_SIGNUP_ERROR_COPY[code]) || FINISH_SIGNUP_FALLBACK;
}

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
        setError(mapFinishSignupError(body));
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

        {/*
          Visible error is aria-hidden so assistive tech announces it exactly
          once — via the assertive LiveRegion below, not twice.
        */}
        {error && (
          <p className="text-sm text-[#b3261e]" aria-hidden="true">
            {error}
          </p>
        )}
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
