'use client';

import Image from 'next/image';
import { useState, type FormEvent } from 'react';
import { useMfaEnrollment } from '@/components/auth/useMfaEnrollment';

/** The pages that stop opening once the last authenticator is gone. */
const AAL2_PAGES = 'Flagged, Autonomy, Offboardings, Suppressions, Send breaker, and Support';

type VerifiedFactor = ReturnType<typeof useMfaEnrollment>['verifiedFactors'][number];

/**
 * What removing this factor costs, read BEFORE the act (X35). Removing the
 * LAST one locks this admin out of every AAL2 page until a new factor is
 * enrolled — a consequence to state up front, not to discover on the next
 * Safety page.
 */
function removeFactorWarning(remainingFactors: number): string {
  if (remainingFactors === 0) {
    return `This is your only authenticator. Removing it locks you out of every step-up (AAL2) page — ${AAL2_PAGES} — until you enroll a new one.`;
  }
  return `Removes this authenticator. Your ${remainingFactors} other${
    remainingFactors === 1 ? '' : 's'
  } keep step-up (AAL2) access working.`;
}

/** The inline confirm a Remove click arms on its own row. */
function RemoveFactorConfirm({
  remainingFactors,
  busy,
  onConfirm,
  onCancel,
}: {
  remainingFactors: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-3">
      <p className="text-sm text-gray-800">{removeFactorWarning(remainingFactors)}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Removing…' : 'Remove authenticator'}
        </button>
        <button
          type="button"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function FactorRow({
  factor,
  armed,
  remainingFactors,
  busy,
  onArm,
  onDisarm,
  onRemove,
}: {
  factor: VerifiedFactor;
  /** This row's confirm is open. */
  armed: boolean;
  /** How many verified factors would remain after this one is removed. */
  remainingFactors: number;
  busy: boolean;
  onArm: () => void;
  onDisarm: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid gap-3 rounded-md border border-gray-200 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-gray-900">{factor.friendlyName ?? 'Authenticator app'}</div>
          <div className="text-xs text-gray-500">
            {factor.factorType.toUpperCase()} · {factor.status}
          </div>
        </div>
        {!armed && (
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            disabled={busy}
            onClick={onArm}
          >
            Remove
          </button>
        )}
      </div>
      {armed && (
        <RemoveFactorConfirm remainingFactors={remainingFactors} busy={busy} onConfirm={onRemove} onCancel={onDisarm} />
      )}
    </div>
  );
}

type Enrollment = NonNullable<ReturnType<typeof useMfaEnrollment>['enrollment']>;

/** Loading → the rows → "none enrolled": the one place the list's three states are decided. */
function FactorList({
  loading,
  factors,
  armedFactorId,
  busy,
  onArm,
  onDisarm,
  onRemove,
}: {
  loading: boolean;
  factors: VerifiedFactor[];
  armedFactorId: string | null;
  busy: boolean;
  onArm: (factorId: string) => void;
  onDisarm: () => void;
  onRemove: (factorId: string) => void;
}) {
  if (loading) return <p className="text-sm text-gray-500">Loading security settings…</p>;
  if (factors.length === 0) return <p className="text-sm text-gray-500">No MFA factor is enrolled.</p>;
  return (
    <div className="grid gap-2.5">
      {factors.map((factor) => (
        <FactorRow
          key={factor.id}
          factor={factor}
          armed={armedFactorId === factor.id}
          remainingFactors={factors.length - 1}
          busy={busy}
          onArm={() => onArm(factor.id)}
          onDisarm={onDisarm}
          onRemove={() => onRemove(factor.id)}
        />
      ))}
    </div>
  );
}

/** The in-progress TOTP enrollment: QR + manual key, then the 6-digit verify. */
function EnrollmentForm({
  enrollment,
  code,
  setCode,
  busy,
  onSubmit,
  onCancel,
}: {
  enrollment: Enrollment;
  code: string;
  setCode: (code: string) => void;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="mt-5">
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
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

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
  // Removing a factor arms an inline confirm on that row (X35); see
  // `removeFactorWarning` for why the last one is called out.
  const [armedFactorId, setArmedFactorId] = useState<string | null>(null);

  function onVerifySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void verifyEnrollment();
  }

  function removeFactor(factorId: string) {
    setArmedFactorId(null);
    void unenrollFactor(factorId);
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
        <FactorList
          loading={loading}
          factors={verifiedFactors}
          armedFactorId={armedFactorId}
          busy={busy}
          onArm={setArmedFactorId}
          onDisarm={() => setArmedFactorId(null)}
          onRemove={removeFactor}
        />
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
        <EnrollmentForm
          enrollment={enrollment}
          code={code}
          setCode={setCode}
          busy={busy}
          onSubmit={onVerifySubmit}
          onCancel={cancelEnrollment}
        />
      )}
    </section>
  );
}
