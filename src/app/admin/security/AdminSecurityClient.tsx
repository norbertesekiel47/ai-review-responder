'use client';

import Image from 'next/image';
import type { FormEvent } from 'react';
import { useMfaEnrollment } from '@/components/auth/useMfaEnrollment';

export function AdminSecurityClient() {
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
    <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-gray-900">Multi-factor authentication</h2>
      <p className="mt-1 text-sm text-gray-600">
        Admin control-plane actions (autonomy, offboarding) require a step-up (AAL2) session. Enroll an
        authenticator app here, then re-open the protected page.
      </p>

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm text-green-700">{notice}</p> : null}

      <div className="mt-5">
        {loading ? (
          <p className="text-sm text-gray-500">Loading security settings…</p>
        ) : verifiedFactors.length > 0 ? (
          <div className="grid gap-2.5">
            {verifiedFactors.map((factor) => (
              <div
                key={factor.id}
                className="flex items-center justify-between gap-3 rounded-md border border-gray-200 p-3"
              >
                <div>
                  <div className="text-sm font-semibold text-gray-900">
                    {factor.friendlyName ?? 'Authenticator app'}
                  </div>
                  <div className="text-xs text-gray-500">
                    {factor.factorType.toUpperCase()} · {factor.status}
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void unenrollFactor(factor.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No MFA factor is enrolled.</p>
        )}
      </div>

      {!enrollment ? (
        <button
          type="button"
          className="mt-5 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          disabled={busy || loading}
          onClick={() => void startEnrollment()}
        >
          {busy ? 'Starting…' : 'Add authenticator app'}
        </button>
      ) : (
        <form onSubmit={onVerifySubmit} className="mt-5">
          {enrollment.qrCode?.startsWith('data:') ? (
            // Supabase returns this QR image from its Auth API; the TOTP secret
            // itself is shown separately for manual entry.
            <Image
              src={enrollment.qrCode}
              alt="Authenticator setup QR code"
              width={180}
              height={180}
              unoptimized
              className="border border-gray-200"
            />
          ) : null}
          {enrollment.secret ? (
            <p className="mt-2.5 text-sm text-gray-900">
              Manual key: <code className="rounded bg-gray-100 px-1 py-0.5">{enrollment.secret}</code>
            </p>
          ) : null}
          <label htmlFor="admin-mfa-code" className="mt-3.5 block text-sm font-semibold text-gray-900">
            Verification code
          </label>
          <input
            id="admin-mfa-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            className="mt-1.5 block w-full max-w-[220px] rounded-md border border-gray-300 px-3 py-2 text-sm"
            required
          />
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              disabled={busy || code.trim().length === 0}
            >
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button
              type="button"
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              disabled={busy}
              onClick={cancelEnrollment}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
