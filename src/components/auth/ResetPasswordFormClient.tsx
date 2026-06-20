'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AuthFlow } from '@/lib/shared/auth-flow';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import {
  AuthCardShell,
  authFieldClass,
  authLabelClass,
  authPrimaryButtonClass,
} from './AuthCardShell';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { MIN_PASSWORD_LENGTH } from '@/lib/shared/schemas';

export interface ResetPasswordFormProps {
  portal: AuthFlow;
  brandName: string;
}

// Curated, human-facing copy for the reset-password server error codes. The
// route returns machine codes (`invalid_body`, `unauthorized`, …) and — on a
// Supabase updateUser failure — a raw provider message. Map known codes to
// curated copy; for an unrecognized code (or a raw Supabase message we don't
// want to surface verbatim), fall back to a generic line so a machine code can
// never reach the UI.
const RESET_PASSWORD_ERROR_COPY: Record<string, string> = {
  invalid_body: "That password doesn't meet the requirements. Please try another.",
  invalid_json: 'Could not read your submission. Please try again.',
  rate_limited:
    'Too many attempts. Please wait a few minutes and try again.',
  rate_limit_unavailable:
    'Password reset is temporarily unavailable. Please try again in a moment.',
  forbidden: 'We could not verify this request. Please reopen the link from your email.',
  unsupported_role: 'This account cannot reset its password here.',
  not_found: 'This page is not available right now.',
  account_incomplete:
    'We could not find your account. Please contact support.',
};

const RESET_PASSWORD_FALLBACK =
  'We could not update your password. Please try again.';

// 401 means the recovery session is missing or expired — surface the dedicated
// expired-link state instead of a generic error so the user gets a clear path
// back to /forgot-password.
const SESSION_EXPIRED_COPY =
  'This reset link has expired — request a new one.';

function mapResetPasswordError(body: { error?: unknown }): string {
  const code = typeof body?.error === 'string' ? body.error : undefined;
  return (code && RESET_PASSWORD_ERROR_COPY[code]) || RESET_PASSWORD_FALLBACK;
}

interface AdminResetPasswordProps {
  brandName: string;
  password: string;
  setPassword: (v: string) => void;
  confirmPw: string;
  setConfirmPw: (v: string) => void;
  error: string;
  loading: boolean;
  handleSubmit: (e: React.FormEvent) => Promise<void>;
}

/** Renders the unchanged utilitarian gray/blue card for the admin portal. */
function AdminResetPassword({
  brandName,
  password,
  setPassword,
  confirmPw,
  setConfirmPw,
  error,
  loading,
  handleSubmit,
}: AdminResetPasswordProps) {
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
          <h2 className="text-base font-medium text-gray-900">
            Set a new password
          </h2>
          <div>
            <label
              htmlFor="new-password"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              New password
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`${MIN_PASSWORD_LENGTH}+ characters`}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label
              htmlFor="confirm-password"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Confirm password
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}

export function ResetPasswordFormClient({ portal, brandName }: ResetPasswordFormProps) {
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // null = still checking; true/false = recovery session present or not.
  const [sessionReady, setSessionReady] = useState<boolean | null>(null);
  const router = useRouter();

  // Mount-time recovery-session probe (owner flow only — the admin card keeps
  // its existing, unchanged behavior). The callback handler exchanges the
  // recovery code into a session cookie before this page renders; if the link
  // was already used or has expired there is no session, so we show the
  // expired-link state up front instead of letting the user type a password
  // that the server will reject with a 401.
  const supabase = useMemo(
    () => (portal === 'owner' ? createBrowserSupabaseClient() : null),
    [portal],
  );

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    async function probeSession() {
      try {
        const {
          data: { user },
        } = await supabase!.auth.getUser();
        if (!cancelled) setSessionReady(Boolean(user));
      } catch {
        // Treat any probe failure as "no usable recovery session" — the worst
        // case is an extra trip through forgot-password, never a stuck form.
        if (!cancelled) setSessionReady(false);
      }
    }
    void probeSession();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const passwordsMatch = password.length > 0 && password === confirmPw;
  const showMismatch = confirmTouched && confirmPw.length > 0 && !passwordsMatch;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmPw) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json()) as {
        error?: string;
        redirectTo?: string;
      };
      if (!res.ok) {
        // A 401 here means the recovery session lapsed between mount and
        // submit — flip to the expired-link state rather than a transient error.
        if (res.status === 401) {
          setSessionReady(false);
          return;
        }
        setError(mapResetPasswordError(body));
        return;
      }
      router.push(body.redirectTo ?? '/login');
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  if (portal === 'admin') {
    return (
      <AdminResetPassword
        brandName={brandName}
        password={password}
        setPassword={setPassword}
        confirmPw={confirmPw}
        setConfirmPw={setConfirmPw}
        error={error}
        loading={loading}
        handleSubmit={handleSubmit}
      />
    );
  }

  // Expired / missing recovery session: dead-end the form with a clear path to
  // request a fresh link.
  if (sessionReady === false) {
    return (
      <AuthCardShell width="sm">
        <LiveRegion level="assertive" message={SESSION_EXPIRED_COPY} />
        <h1 className="text-2xl font-semibold text-[#2a2a2a]">Reset link expired</h1>
        <p className="mt-2 text-[#6a6a6a]">{SESSION_EXPIRED_COPY}</p>
        <Link
          href="/forgot-password"
          className="mt-6 inline-block text-sm font-medium text-[#557069] hover:underline"
        >
          Request a new reset link
        </Link>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell width="sm">
      <LiveRegion level="assertive" message={error} />
      <form onSubmit={handleSubmit} className="space-y-4">
        <h1 className="text-2xl font-semibold text-[#2a2a2a]">Set a new password</h1>
        <div>
          <label htmlFor="new-password" className={authLabelClass}>New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={`${MIN_PASSWORD_LENGTH}+ characters`}
            className={authFieldClass}
          />
        </div>
        <div>
          <label htmlFor="confirm-password" className={authLabelClass}>Confirm password</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            onBlur={() => setConfirmTouched(true)}
            aria-invalid={showMismatch || undefined}
            aria-describedby="confirm-password-feedback"
            className={authFieldClass}
          />
          {/* Inline match feedback on blur. aria-hidden — the assertive error
              LiveRegion already owns announcements; this is a visual aid only. */}
          <p
            id="confirm-password-feedback"
            aria-hidden="true"
            className="mt-1 min-h-[1rem] text-xs"
          >
            {showMismatch ? (
              <span className="text-[#b3261e]">Passwords don&apos;t match.</span>
            ) : confirmTouched && passwordsMatch ? (
              <span className="text-[#1d6b4f]">Passwords match.</span>
            ) : null}
          </p>
        </div>
        {error && <p className="text-sm text-[#b3261e]" aria-hidden="true">{error}</p>}
        <button type="submit" disabled={loading} className={authPrimaryButtonClass}>
          {loading ? 'Updating...' : 'Update password'}
        </button>
      </form>
    </AuthCardShell>
  );
}
