'use client';

// Owner Security settings: two-step sign-in (an authenticator app) and the
// password. The MFA flow itself lives in useMfaEnrollment (shared with the
// admin surface); this file owns only the owner-facing presentation.
//
// Truthful by design (UX audit S21/S22): Supabase MFA has no recovery codes,
// so the page says so and names the actual fallback (support resets it); the
// password is changed through the existing reset flow, not a second route.

import Image from 'next/image';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useMfaEnrollment, type MfaFactor } from '@/components/auth/useMfaEnrollment';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';
import { SettingsSkeleton } from '@/components/dashboard/settings/SettingsSkeleton';

/** Where the owner re-verifies with the authenticator before a removal (AAL2 step-up). */
export const STEP_UP_HREF = '/mfa/challenge?next=/settings/security';

/** The existing owner password-reset flow — no second password route (S22, pre-decided). */
export const CHANGE_PASSWORD_HREF = '/forgot-password';

// Explicit locale + timeZone so the text is stable across viewers and tests.
const ADDED_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Authenticator app · Added Mar 3, 2026" — never the factor type or its raw status. */
export function factorSummary(factor: Pick<MfaFactor, 'createdAt'>): string {
  if (!factor.createdAt) return 'Authenticator app';
  const added = new Date(factor.createdAt);
  if (Number.isNaN(added.getTime())) return 'Authenticator app';
  return `Authenticator app · Added ${ADDED_DATE_FORMATTER.format(added)}`;
}

/**
 * The hook reports an AAL2 refusal as a sentence, not a code; this is the one
 * error that has a next step (re-verify), so it gets a link.
 */
export function isStepUpRequiredError(error: string | null): boolean {
  return error !== null && /sign in again/i.test(error);
}

export function SecurityClient() {
  const {
    verifiedFactors,
    loading,
    busy,
    error,
    notice,
    enrollment,
    code,
    setCode,
    startEnrollment,
    verifyEnrollment,
    cancelEnrollment,
    unenrollFactor,
  } = useMfaEnrollment();
  const [factorToRemove, setFactorToRemove] = useState<MfaFactor | null>(null);

  function onVerifySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void verifyEnrollment();
  }

  async function confirmRemoval() {
    if (!factorToRemove) return;
    const factorId = factorToRemove.id;
    setFactorToRemove(null);
    await unenrollFactor(factorId);
  }

  const twoStepOn = verifiedFactors.length > 0;

  return (
    <>
      <div className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon sage" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
          </div>
          <div>
            <div className="set-section-title">Two-step sign-in</div>
            <div className="set-section-sub">
              Add an authenticator app and we&apos;ll ask for its 6-digit code each time you sign in.
              Someone with just your password can&apos;t get in.
            </div>
          </div>
        </div>

        {error ? (
          <p role="alert" className="settings-error-copy">
            {error}
            {isStepUpRequiredError(error) && (
              <>
                {' '}
                <Link href={STEP_UP_HREF} className="settings-error-link">
                  Verify with your authenticator
                </Link>
              </>
            )}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="settings-notice-copy">{notice}</p>
        ) : null}

        {loading ? (
          <SettingsSkeleton rows={2} />
        ) : twoStepOn ? (
          <div className="security-factor-list">
            {verifiedFactors.map((factor) => (
              <div key={factor.id} className="security-factor-row">
                <div>
                  <div className="security-factor-name">{factor.friendlyName ?? 'Authenticator app'}</div>
                  <div className="security-factor-meta">{factorSummary(factor)}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => setFactorToRemove(factor)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="settings-body-copy">
            Two-step sign-in is off. Add an authenticator app to turn it on.
          </p>
        )}

        {!loading && !enrollment ? (
          <button
            type="button"
            className="btn btn-primary"
            style={{ alignSelf: 'flex-start' }}
            disabled={busy}
            onClick={() => void startEnrollment()}
          >
            {busy ? 'Starting…' : twoStepOn ? 'Add another authenticator app' : 'Add authenticator app'}
          </button>
        ) : null}

        {enrollment ? (
          <form onSubmit={onVerifySubmit} className="security-enroll-form">
            <p className="settings-body-copy">
              Scan this code with your authenticator app (Google Authenticator, 1Password, Authy…),
              then enter the 6-digit code it shows.
            </p>
            {enrollment.qrCode?.startsWith('data:') ? (
              // Supabase returns this QR image from its Auth API; the secret
              // itself is shown separately for manual entry.
              <Image
                src={enrollment.qrCode}
                alt="Authenticator setup QR code"
                width={180}
                height={180}
                unoptimized
                className="security-enroll-qr"
              />
            ) : null}
            {enrollment.secret ? (
              <p className="settings-body-copy">
                Can&apos;t scan? Enter this key by hand: <code className="security-manual-key">{enrollment.secret}</code>
              </p>
            ) : null}
            <div className="field" style={{ maxWidth: 220 }}>
              <label htmlFor="mfa-code" className="field-label">6-digit code</label>
              <input
                id="mfa-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                className="input"
                required
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || code.trim().length === 0}
              >
                {busy ? 'Verifying…' : 'Turn on two-step sign-in'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={cancelEnrollment}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        <p className="settings-body-copy security-recovery-note">
          <strong>If you lose your authenticator:</strong> there are no backup codes.{' '}
          <Link href="/help/contact" className="settings-inline-link">Contact support</Link> — we&apos;ll
          verify it&apos;s you and reset two-step sign-in so you can set it up again.
        </p>
      </div>

      <div className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon blue" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          </div>
          <div>
            <div className="set-section-title">Password</div>
            <div className="set-section-sub">
              We&apos;ll email you a link to choose a new password. It works even if you&apos;re signed in.
            </div>
          </div>
        </div>
        <Link href={CHANGE_PASSWORD_HREF} className="btn btn-secondary" style={{ alignSelf: 'flex-start' }}>
          Change password
        </Link>
      </div>

      {factorToRemove && (
        <SettingsModal
          title="Remove authenticator app"
          closeLabel="Keep two-step sign-in"
          onClose={() => setFactorToRemove(null)}
        >
          <div className="set-section-title" style={{ marginBottom: 8 }}>
            Remove this authenticator app?
          </div>
          <p className="settings-body-copy" style={{ marginBottom: 16 }}>
            Signing in will need only your password. You can add an authenticator app again at any
            time. You may be asked to enter a code from it first.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setFactorToRemove(null)}>
              Keep it
            </button>
            <button type="button" className="btn-danger" onClick={() => void confirmRemoval()}>
              Remove authenticator app
            </button>
          </div>
        </SettingsModal>
      )}
    </>
  );
}
