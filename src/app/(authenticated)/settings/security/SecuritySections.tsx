'use client';

// The owner Security page, in sections. SecurityClient owns the MFA hook and
// the removal confirmation; each piece here renders one slice of that state —
// the error line (with its one actionable link), the factor list, the
// enrollment form, and the static password section — so the page itself reads
// as composition.

import Image from 'next/image';
import Link from 'next/link';
import type { FormEvent } from 'react';
import type { MfaEnrollmentState, MfaFactor } from '@/components/auth/useMfaEnrollment';
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

/** Label for the add-factor button: what it does, or that it is doing it. */
export function addFactorLabel(busy: boolean, twoStepOn: boolean): string {
  if (busy) return 'Starting…';
  return twoStepOn ? 'Add another authenticator app' : 'Add authenticator app';
}

/** The hook's error sentence, with the step-up link when that is the fix. */
export function SecurityErrorNotice({ error }: { error: string | null }) {
  if (!error) return null;
  return (
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
  );
}

/** Skeleton while loading, the "off" sentence with no factor, else one row per factor. */
export function SecurityFactorList({
  loading,
  factors,
  busy,
  onRemove,
}: {
  loading: boolean;
  factors: MfaFactor[];
  busy: boolean;
  onRemove: (factor: MfaFactor) => void;
}) {
  if (loading) return <SettingsSkeleton rows={2} />;
  if (factors.length === 0) {
    return (
      <p className="settings-body-copy">
        Two-step sign-in is off. Add an authenticator app to turn it on.
      </p>
    );
  }
  return (
    <div className="security-factor-list">
      {factors.map((factor) => (
        <div key={factor.id} className="security-factor-row">
          <div>
            <div className="security-factor-name">{factor.friendlyName ?? 'Authenticator app'}</div>
            <div className="security-factor-meta">{factorSummary(factor)}</div>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => onRemove(factor)}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

/** QR + manual key + the 6-digit code field for an in-progress enrollment. */
export function SecurityEnrollForm({
  enrollment,
  code,
  busy,
  onCodeChange,
  onSubmit,
  onCancel,
}: {
  enrollment: MfaEnrollmentState;
  code: string;
  busy: boolean;
  onCodeChange: (code: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="security-enroll-form">
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
          onChange={(event) => onCodeChange(event.target.value)}
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
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The password section: a link into the existing reset flow, nothing more (S22). */
export function PasswordSection() {
  return (
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
  );
}
