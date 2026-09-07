'use client';

// Owner Security settings: two-step sign-in (an authenticator app) and the
// password. The MFA flow itself lives in useMfaEnrollment (shared with the
// admin surface); this file owns only the owner-facing presentation, composed
// from the sections in SecuritySections.tsx.
//
// Truthful by design (UX audit S21/S22): Supabase MFA has no recovery codes,
// so the page says so and names the actual fallback (support resets it); the
// password is changed through the existing reset flow, not a second route.

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useMfaEnrollment, type MfaFactor } from '@/components/auth/useMfaEnrollment';
import { ConfirmDialog } from '@/components/dashboard/settings/ConfirmDialog';
import {
  PasswordSection,
  SecurityEnrollForm,
  SecurityErrorNotice,
  SecurityFactorList,
  addFactorLabel,
} from './SecuritySections';

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

        <SecurityErrorNotice error={error} />
        {notice ? (
          <p role="status" className="settings-notice-copy">{notice}</p>
        ) : null}

        <SecurityFactorList
          loading={loading}
          factors={verifiedFactors}
          busy={busy}
          onRemove={setFactorToRemove}
        />

        {!loading && !enrollment ? (
          <button
            type="button"
            className="btn btn-primary"
            style={{ alignSelf: 'flex-start' }}
            disabled={busy}
            onClick={() => void startEnrollment()}
          >
            {addFactorLabel(busy, twoStepOn)}
          </button>
        ) : null}

        {enrollment ? (
          <SecurityEnrollForm
            enrollment={enrollment}
            code={code}
            busy={busy}
            onCodeChange={setCode}
            onSubmit={onVerifySubmit}
            onCancel={cancelEnrollment}
          />
        ) : null}

        <p className="settings-body-copy security-recovery-note">
          <strong>If you lose your authenticator:</strong> there are no backup codes.{' '}
          <Link href="/help/contact" className="settings-inline-link">Contact support</Link> and we&apos;ll
          verify it&apos;s you, then reset two-step sign-in so you can set it up again.
        </p>
      </div>

      <PasswordSection />

      {factorToRemove && (
        <ConfirmDialog
          title="Remove authenticator app"
          closeLabel="Keep two-step sign-in"
          heading="Remove this authenticator app?"
          body="Signing in will need only your password. You can add an authenticator app again at any time. You may be asked to enter a code from it first."
          cancelLabel="Keep it"
          confirmLabel="Remove authenticator app"
          onCancel={() => setFactorToRemove(null)}
          onConfirm={() => void confirmRemoval()}
        />
      )}
    </>
  );
}
