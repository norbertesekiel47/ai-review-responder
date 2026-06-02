'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

interface MfaFactor {
  id: string;
  friendlyName: string | null;
  factorType: string;
  status: string;
  createdAt: string | null;
}

interface EnrollmentState {
  factorId: string;
  qrCode: string | null;
  secret: string | null;
}

function normalizeFactor(raw: unknown): MfaFactor | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : null;
  if (!id) return null;
  return {
    id,
    friendlyName:
      typeof record.friendly_name === 'string'
        ? record.friendly_name
        : typeof record.friendlyName === 'string'
          ? record.friendlyName
          : null,
    factorType:
      typeof record.factor_type === 'string'
        ? record.factor_type
        : typeof record.factorType === 'string'
          ? record.factorType
          : 'totp',
    status: typeof record.status === 'string' ? record.status : 'unknown',
    createdAt:
      typeof record.created_at === 'string'
        ? record.created_at
        : typeof record.createdAt === 'string'
          ? record.createdAt
          : null,
  };
}

function normalizeFactors(data: unknown): MfaFactor[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const candidates = [
    ...(Array.isArray(record.totp) ? record.totp : []),
    ...(Array.isArray(record.all) ? record.all : []),
  ];
  const unique = new Map<string, MfaFactor>();
  for (const candidate of candidates) {
    const factor = normalizeFactor(candidate);
    if (factor) unique.set(factor.id, factor);
  }
  return [...unique.values()];
}

export function SecurityClient() {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentState | null>(null);
  const [code, setCode] = useState('');

  const verifiedFactors = factors.filter((factor) => factor.status === 'verified');

  const loadFactors = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) {
      setError('Could not load MFA factors.');
      setLoading(false);
      return;
    }
    setFactors(normalizeFactors(data));
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void loadFactors();
  }, [loadFactors]);

  async function startEnrollment() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'RepWorth',
      });
      if (enrollError || !data) {
        setError('Could not start MFA enrollment.');
        return;
      }
      const record = data as unknown as Record<string, unknown>;
      const totp = record.totp as Record<string, unknown> | undefined;
      setEnrollment({
        factorId: String(record.id),
        qrCode: typeof totp?.qr_code === 'string' ? totp.qr_code : null,
        secret: typeof totp?.secret === 'string' ? totp.secret : null,
      });
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function verifyEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollment) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const challengeRes = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'challenge', factorId: enrollment.factorId }),
      });
      if (challengeRes.status === 429) {
        setError('Too many MFA attempts. Try again in a few minutes.');
        return;
      }
      const challenge = await challengeRes.json().catch(() => ({}));
      if (!challengeRes.ok || typeof challenge.challengeId !== 'string') {
        setError('Could not create MFA challenge.');
        return;
      }
      const verifyRes = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify',
          factorId: enrollment.factorId,
          challengeId: challenge.challengeId,
          code,
        }),
      });
      if (verifyRes.status === 429) {
        setError('Too many MFA attempts. Try again in a few minutes.');
        return;
      }
      if (!verifyRes.ok) {
        setError('The verification code was not accepted.');
        return;
      }
      setEnrollment(null);
      setCode('');
      setNotice('MFA factor enrolled.');
      await loadFactors();
    } finally {
      setBusy(false);
    }
  }

  async function unenrollFactor(factorId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Routed through the server so removal requires a current AAL2 session and
      // is audit-logged — never a direct AAL1 client-side unenroll.
      const res = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unenroll', factorId }),
      });
      if (res.status === 403) {
        setError('Sign in again with your authenticator before removing this factor.');
        return;
      }
      if (res.status === 429) {
        setError('Too many attempts. Try again in a few minutes.');
        return;
      }
      if (!res.ok) {
        setError('Could not remove MFA factor. Verify your current session and try again.');
        return;
      }
      setNotice('MFA factor removed.');
      await loadFactors();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="set-section">
      <div className="set-section-title">Multi-factor authentication</div>
      <p style={{ fontSize: 13, color: '#4B5563', marginTop: 4 }}>
        Add a second factor as a backup.
      </p>
      <p style={{ fontSize: 13, color: '#6B7280', marginTop: 6 }}>
        Lost access to your authenticator?{' '}
        <Link href="/help/contact" style={{ color: '#2563EB', textDecoration: 'underline' }}>
          Contact support
        </Link>
        .
      </p>

      {error ? (
        <p style={{ fontSize: 13, color: '#DC2626', marginTop: 12 }}>{error}</p>
      ) : null}
      {notice ? (
        <p style={{ fontSize: 13, color: '#047857', marginTop: 12 }}>{notice}</p>
      ) : null}

      <div style={{ marginTop: 18 }}>
        {loading ? (
          <p style={{ fontSize: 13, color: '#6B7280' }}>Loading security settings…</p>
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
                  border: '1px solid #E5E7EB',
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
                    {factor.friendlyName ?? 'Authenticator app'}
                  </div>
                  <div style={{ fontSize: 12, color: '#6B7280' }}>
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
          <p style={{ fontSize: 13, color: '#6B7280' }}>No MFA factor is enrolled.</p>
        )}
      </div>

      {!enrollment ? (
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 18, background: 'var(--rw-blue-600)' }}
          disabled={busy || loading}
          onClick={() => void startEnrollment()}
        >
          {busy ? 'Starting…' : 'Add authenticator app'}
        </button>
      ) : (
        <form onSubmit={(event) => void verifyEnrollment(event)} style={{ marginTop: 18 }}>
          {enrollment.qrCode?.startsWith('data:') ? (
            // Supabase returns this QR image from its Auth API; the TOTP secret
            // itself is shown separately for manual entry.
            // QR is a runtime base64 data: URI — next/image cannot optimize a data URL.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={enrollment.qrCode}
              alt="Authenticator setup QR code"
              style={{ width: 180, height: 180, border: '1px solid #E5E7EB' }}
            />
          ) : null}
          {enrollment.secret ? (
            <p style={{ fontSize: 13, color: '#374151', marginTop: 10 }}>
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
              style={{ background: 'var(--rw-blue-600)' }}
              disabled={busy || code.trim().length === 0}
            >
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setEnrollment(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
