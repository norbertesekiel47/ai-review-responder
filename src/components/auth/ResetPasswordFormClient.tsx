'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AuthFlow } from '@/lib/shared/auth-flow';
import {
  AuthCardShell,
  authFieldClass,
  authLabelClass,
  authPrimaryButtonClass,
} from './AuthCardShell';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { fetchWithTimeout } from '@/components/auth/shared/fetchWithTimeout';
import { MIN_PASSWORD_LENGTH } from '@/lib/shared/schemas';
import {
  useRecoveryStepUp,
  type UseRecoveryStepUp,
} from '@/components/auth/useRecoveryStepUp';
import { RecoveryStepUpField } from '@/components/auth/RecoveryStepUpField';

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
  mfa_required:
    'Enter the current code from your authenticator app to continue.',
  mfa_check_failed:
    'We could not verify your security settings. Please try again in a moment.',
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
  stepUp: UseRecoveryStepUp;
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
  stepUp,
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
          {stepUp.status === 'code-required' ? (
            <RecoveryStepUpField
              factors={stepUp.factors}
              selectedFactorId={stepUp.selectedFactorId}
              onSelectFactor={stepUp.selectFactor}
              code={stepUp.code}
              onCodeChange={stepUp.setCode}
              labelClassName="block text-sm font-medium text-gray-700 mb-1"
              inputClassName="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              supportLinkClassName="mt-2 block text-sm text-blue-600 hover:underline"
            />
          ) : null}
          {stepUp.error && <p className="text-sm text-red-600">{stepUp.error}</p>}
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
  const [sessionExpiredFallback, setSessionExpiredFallback] = useState(false);
  const router = useRouter();

  // Owns the recovery-session probe AND the MFA step-up for BOTH portals. The
  // callback handler exchanges the recovery code into a session cookie before
  // this page renders; if the link was already used or has expired there is no
  // session, so we show the expired-link state up front instead of letting the
  // user type a password the server will reject.
  const stepUp = useRecoveryStepUp();
  const sessionExpired = stepUp.status === 'no-session' || sessionExpiredFallback;

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
      // Step up FIRST. A mistyped code stops here and never reaches the reset
      // route, which keeps a bad code off the reset route's 5/hr budget — it
      // spends the challenge route's 8/hr verify budget instead. No-ops and
      // reports success when the account has no factor, or when a previous
      // submit already cleared the session to AAL2.
      const cleared = await stepUp.verify();
      if (!cleared) return;

      const res = await fetchWithTimeout('/api/auth/reset-password', {
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
          setSessionExpiredFallback(true);
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

  // Expired / missing recovery session: dead-end both portals with a clear path
  // to request a fresh link. Previously owner-only — the admin card had no
  // probe at all and let the user type a password into a dead session.
  if (sessionExpired) {
    const href = portal === 'admin' ? '/admin/forgot-password' : '/forgot-password';
    if (portal === 'admin') {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">
              {brandName}
            </h1>
            <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
              <h2 className="text-base font-medium text-gray-900">
                Reset link expired
              </h2>
              <p className="text-sm text-gray-600">{SESSION_EXPIRED_COPY}</p>
              <Link href={href} className="text-sm font-medium text-blue-600 hover:underline">
                Request a new reset link
              </Link>
            </div>
          </div>
        </div>
      );
    }
    return (
      <AuthCardShell width="sm">
        <LiveRegion level="assertive" message={SESSION_EXPIRED_COPY} />
        <h1 className="text-2xl font-semibold text-rw-ink">Reset link expired</h1>
        <p className="mt-2 text-rw-ink-soft">{SESSION_EXPIRED_COPY}</p>
        <Link
          href={href}
          className="mt-6 inline-block text-sm font-medium text-rw-teal-strong hover:underline"
        >
          Request a new reset link
        </Link>
      </AuthCardShell>
    );
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
        stepUp={stepUp}
      />
    );
  }

  return (
    <AuthCardShell width="sm">
      <LiveRegion level="assertive" message={error || stepUp.error || ''} />
      <form onSubmit={handleSubmit} className="space-y-4">
        <h1 className="text-2xl font-semibold text-rw-ink">Set a new password</h1>
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
              <span className="text-rw-error">Passwords don&apos;t match.</span>
            ) : confirmTouched && passwordsMatch ? (
              <span className="text-rw-success">Passwords match.</span>
            ) : null}
          </p>
        </div>
        {stepUp.status === 'code-required' ? (
          <RecoveryStepUpField
            factors={stepUp.factors}
            selectedFactorId={stepUp.selectedFactorId}
            onSelectFactor={stepUp.selectFactor}
            code={stepUp.code}
            onCodeChange={stepUp.setCode}
            labelClassName={authLabelClass}
            inputClassName={authFieldClass}
            supportLinkClassName="mt-2 block text-sm font-medium text-rw-teal-strong hover:underline"
          />
        ) : null}
        {stepUp.error && (
          <p className="text-sm text-rw-error" aria-hidden="true">{stepUp.error}</p>
        )}
        {error && <p className="text-sm text-rw-error" aria-hidden="true">{error}</p>}
        <button type="submit" disabled={loading} className={authPrimaryButtonClass}>
          {loading ? 'Updating...' : 'Update password'}
        </button>
      </form>
    </AuthCardShell>
  );
}
