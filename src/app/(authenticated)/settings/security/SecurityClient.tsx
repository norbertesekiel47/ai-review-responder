'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { FormEvent } from 'react';
import { useMfaEnrollment } from '@/components/auth/useMfaEnrollment';

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

  function onVerifySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void verifyEnrollment();
  }

  return (
    <div className="set-section">
      <div className="set-section-title">Multi-factor authentication</div>
      <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', marginTop: 4 }}>
        Add a second factor as a backup.
      </p>
      <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', marginTop: 6 }}>
        Lost access to your authenticator?{' '}
        <Link href="/help/contact" style={{ color: 'var(--rw-sage-deep)', textDecoration: 'underline' }}>
          Contact support
        </Link>
        .
      </p>

      {error ? (
        <p style={{ fontSize: 13, color: 'var(--rw-danger)', marginTop: 12 }}>{error}</p>
      ) : null}
      {notice ? (
        <p style={{ fontSize: 13, color: 'var(--rw-sage-deep)', marginTop: 12 }}>{notice}</p>
      ) : null}

      <div style={{ marginTop: 18 }}>
        {loading ? (
          <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)' }}>Loading security settings…</p>
        ) : verifiedFactors.length > 0 ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {verifiedFactors.map((factor) => (
              <div
                key={factor.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  border: '1px solid var(--rw-hair)',
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--rw-app-text)' }}>
                    {factor.friendlyName ?? 'Authenticator app'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--rw-app-text-muted)' }}>
                    {factor.factorType.toUpperCase()} · {factor.status}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void unenrollFactor(factor.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)' }}>No MFA factor is enrolled.</p>
        )}
      </div>

      {!enrollment ? (
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 18, background: 'var(--rw-accent-600)' }}
          disabled={busy || loading}
          onClick={() => void startEnrollment()}
        >
          {busy ? 'Starting…' : 'Add authenticator app'}
        </button>
      ) : (
        <form onSubmit={onVerifySubmit} style={{ marginTop: 18 }}>
          {enrollment.qrCode?.startsWith('data:') ? (
            // Supabase returns this QR image from its Auth API; the TOTP secret
            // itself is shown separately for manual entry.
            <Image
              src={enrollment.qrCode}
              alt="Authenticator setup QR code"
              width={180}
              height={180}
              unoptimized
              style={{ border: '1px solid var(--rw-hair)' }}
            />
          ) : null}
          {enrollment.secret ? (
            <p style={{ fontSize: 13, color: 'var(--rw-app-text)', marginTop: 10 }}>
              Manual key: <code>{enrollment.secret}</code>
            </p>
          ) : null}
          <label
            htmlFor="mfa-code"
            style={{ display: 'block', fontSize: 13, fontWeight: 600, marginTop: 14 }}
          >
            Verification code
          </label>
          <input
            id="mfa-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            className="input"
            style={{ marginTop: 6, maxWidth: 220 }}
            required
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              type="submit"
              className="btn btn-primary"
              style={{ background: 'var(--rw-accent-600)' }}
              disabled={busy || code.trim().length === 0}
            >
              {busy ? 'Verifying…' : 'Verify'}
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
      )}
    </div>
  );
}
