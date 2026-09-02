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
import { fetchWithTimeout } from './shared/fetchWithTimeout';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

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
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  // "Not you?" exit for someone who picked the wrong Google account. Without
  // it the email was a disabled field and the only way out was the URL bar
  // (A17). Back to /signup, where the Google button started this.
  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setError('');
    try {
      const { error: signOutError } = await createBrowserSupabaseClient().auth.signOut();
      if (signOutError) throw signOutError;
      router.push('/signup');
      router.refresh();
    } catch {
      setSigningOut(false);
      setError("Couldn't sign you out. Check your connection and try again.");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetchWithTimeout('/api/auth/finish-signup', {
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
      setError("Couldn't reach RepWorth. Check your connection and try again.");
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
      <h1 className="text-2xl font-semibold text-rw-ink text-center mb-2">
        Almost there, just your name
      </h1>
      <p className="text-center text-rw-ink-soft mb-8">
        We&apos;ll set up your business after payment.
      </p>

      <form
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        {/* The email is fixed to the Google account — text, not a field the
            owner will try to edit. */}
        <p className="text-sm text-rw-ink-soft">
          Signed in with Google as{' '}
          <span className="font-medium text-rw-ink [overflow-wrap:anywhere]">{defaultEmail}</span>
          {' · '}
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut || loading}
            className="font-medium text-rw-teal-strong hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {signingOut ? 'Signing out…' : 'Not you? Sign out'}
          </button>
        </p>
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
          <p className="text-sm text-rw-error" aria-hidden="true">
            {error}
          </p>
        )}
        <LiveRegion level="assertive" message={error} />

        <button
          type="submit"
          disabled={loading || signingOut}
          className={authPrimaryButtonClass}
        >
          {loading ? 'Submitting...' : 'Continue'}
        </button>
      </form>
    </AuthCardShell>
  );
}
