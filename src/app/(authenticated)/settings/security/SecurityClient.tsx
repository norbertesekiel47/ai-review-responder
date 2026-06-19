'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useReducer, type FormEvent } from 'react';
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

interface SecurityState {
  factors: MfaFactor[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  enrollment: EnrollmentState | null;
  code: string;
}

type SecurityAction =
  | { type: 'loadStart' }
  | { type: 'loadError'; error: string }
  | { type: 'loadSuccess'; factors: MfaFactor[] }
  | { type: 'actionStart' }
  | { type: 'setError'; error: string }
  | { type: 'enrollmentStarted'; enrollment: EnrollmentState }
  | { type: 'enrollmentVerified'; notice: string }
  | { type: 'setNotice'; notice: string }
  | { type: 'actionDone' }
  | { type: 'setCode'; value: string }
  | { type: 'cancelEnrollment' };

const initialState: SecurityState = {
  factors: [],
  loading: true,
  busy: false,
  error: null,
  notice: null,
  enrollment: null,
  code: '',
};

function reducer(state: SecurityState, action: SecurityAction): SecurityState {
  switch (action.type) {
    case 'loadStart':
      return { ...state, loading: true, error: null };
    case 'loadError':
      return { ...state, error: action.error, loading: false };
    case 'loadSuccess':
      return { ...state, factors: action.factors, loading: false };
    case 'actionStart':
      return { ...state, busy: true, error: null, notice: null };
    case 'setError':
      return { ...state, error: action.error };
    case 'enrollmentStarted':
      return { ...state, enrollment: action.enrollment, code: '' };
    case 'enrollmentVerified':
      return { ...state, enrollment: null, code: '', notice: action.notice };
    case 'setNotice':
      return { ...state, notice: action.notice };
    case 'actionDone':
      return { ...state, busy: false };
    case 'setCode':
      return { ...state, code: action.value };
    case 'cancelEnrollment':
      return { ...state, enrollment: null };
  }
}

export function SecurityClient() {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [state, dispatch] = useReducer(reducer, initialState);
  const { factors, loading, busy, error, notice, enrollment, code } = state;

  const verifiedFactors = factors.filter((factor) => factor.status === 'verified');

  const loadFactors = useCallback(async () => {
    dispatch({ type: 'loadStart' });
    const { data, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) {
      dispatch({ type: 'loadError', error: 'Could not load MFA factors.' });
      return;
    }
    dispatch({ type: 'loadSuccess', factors: normalizeFactors(data) });
  }, [supabase]);

  useEffect(() => {
    void loadFactors();
  }, [loadFactors]);

  async function startEnrollment() {
    dispatch({ type: 'actionStart' });
    try {
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'RepWorth',
      });
      if (enrollError || !data) {
        dispatch({ type: 'setError', error: 'Could not start MFA enrollment.' });
        return;
      }
      const record = data as unknown as Record<string, unknown>;
      const totp = record.totp as Record<string, unknown> | undefined;
      dispatch({
        type: 'enrollmentStarted',
        enrollment: {
          factorId: String(record.id),
          qrCode: typeof totp?.qr_code === 'string' ? totp.qr_code : null,
          secret: typeof totp?.secret === 'string' ? totp.secret : null,
        },
      });
    } finally {
      dispatch({ type: 'actionDone' });
    }
  }

  async function verifyEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollment) return;
    dispatch({ type: 'actionStart' });
    try {
      const challengeRes = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'challenge', factorId: enrollment.factorId }),
      });
      if (challengeRes.status === 429) {
        dispatch({ type: 'setError', error: 'Too many MFA attempts. Try again in a few minutes.' });
        return;
      }
      const challenge = await challengeRes.json().catch(() => ({}));
      if (!challengeRes.ok || typeof challenge.challengeId !== 'string') {
        dispatch({ type: 'setError', error: 'Could not create MFA challenge.' });
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
        dispatch({ type: 'setError', error: 'Too many MFA attempts. Try again in a few minutes.' });
        return;
      }
      if (!verifyRes.ok) {
        dispatch({ type: 'setError', error: 'The verification code was not accepted.' });
        return;
      }
      dispatch({ type: 'enrollmentVerified', notice: 'MFA factor enrolled.' });
      await loadFactors();
    } finally {
      dispatch({ type: 'actionDone' });
    }
  }

  async function unenrollFactor(factorId: string) {
    dispatch({ type: 'actionStart' });
    try {
      // Routed through the server so removal requires a current AAL2 session and
      // is audit-logged — never a direct AAL1 client-side unenroll.
      const res = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unenroll', factorId }),
      });
      if (res.status === 403) {
        dispatch({ type: 'setError', error: 'Sign in again with your authenticator before removing this factor.' });
        return;
      }
      if (res.status === 429) {
        dispatch({ type: 'setError', error: 'Too many attempts. Try again in a few minutes.' });
        return;
      }
      if (!res.ok) {
        dispatch({ type: 'setError', error: 'Could not remove MFA factor. Verify your current session and try again.' });
        return;
      }
      dispatch({ type: 'setNotice', notice: 'MFA factor removed.' });
      await loadFactors();
    } finally {
      dispatch({ type: 'actionDone' });
    }
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
            onChange={(event) => dispatch({ type: 'setCode', value: event.target.value })}
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
              onClick={() => dispatch({ type: 'cancelEnrollment' })}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
