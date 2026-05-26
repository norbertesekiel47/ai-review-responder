'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

interface ChallengeFactor {
  id: string;
  label: string;
}

function normalizeFactor(raw: unknown): ChallengeFactor | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  if (record.status !== 'verified') return null;
  const label =
    typeof record.friendly_name === 'string'
      ? record.friendly_name
      : typeof record.friendlyName === 'string'
        ? record.friendlyName
        : 'Authenticator app';
  return { id: record.id, label };
}

function normalizeFactors(data: unknown): ChallengeFactor[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const candidates = [
    ...(Array.isArray(record.totp) ? record.totp : []),
    ...(Array.isArray(record.all) ? record.all : []),
  ];
  const unique = new Map<string, ChallengeFactor>();
  for (const candidate of candidates) {
    const factor = normalizeFactor(candidate);
    if (factor) unique.set(factor.id, factor);
  }
  return [...unique.values()];
}

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard';
  if (
    raw === '/login' ||
    raw === '/admin/login' ||
    raw.startsWith('/forgot-password') ||
    raw.startsWith('/admin/forgot-password')
  ) {
    return '/dashboard';
  }
  return raw;
}

export default function MfaChallengePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [factors, setFactors] = useState<ChallengeFactor[]>([]);
  const [selectedFactorId, setSelectedFactorId] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadFactors() {
      setLoading(true);
      setError(null);
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (listError) {
        setError('Could not load MFA factors.');
        setLoading(false);
        return;
      }
      const nextFactors = normalizeFactors(data);
      setFactors(nextFactors);
      setSelectedFactorId(nextFactors[0]?.id ?? '');
      setLoading(false);
    }
    void loadFactors();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  async function ensureChallenge(factorId: string): Promise<string | null> {
    if (challengeId) return challengeId;
    const res = await fetch('/api/auth/mfa/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'challenge', factorId }),
    });
    if (res.status === 429) {
      setError('Too many MFA attempts. Try again in a few minutes.');
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.challengeId !== 'string') {
      setError('Could not start MFA challenge.');
      return null;
    }
    setChallengeId(data.challengeId);
    return data.challengeId;
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFactorId) return;
    setBusy(true);
    setError(null);
    try {
      const nextChallengeId = await ensureChallenge(selectedFactorId);
      if (!nextChallengeId) return;
      const res = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify',
          factorId: selectedFactorId,
          challengeId: nextChallengeId,
          code,
        }),
      });
      if (res.status === 429) {
        setError('Too many MFA attempts. Try again in a few minutes.');
        setChallengeId(null);
        return;
      }
      if (!res.ok) {
        setError('The verification code was not accepted.');
        setChallengeId(null);
        return;
      }
      router.push(next);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">
          Verify sign-in
        </h1>
        <form className="bg-white rounded-lg border border-gray-200 p-6 space-y-4" onSubmit={(event) => void verify(event)}>
          {loading ? (
            <p className="text-sm text-gray-600">Loading MFA factors…</p>
          ) : factors.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-700">
                No verified MFA factor is available for this account.
              </p>
              <Link className="text-sm text-blue-600 hover:underline" href="/login">
                Return to login
              </Link>
            </div>
          ) : (
            <>
              {factors.length > 1 ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="mfa-factor">
                    Factor
                  </label>
                  <select
                    id="mfa-factor"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    value={selectedFactorId}
                    onChange={(event) => {
                      setSelectedFactorId(event.target.value);
                      setChallengeId(null);
                    }}
                  >
                    {factors.map((factor) => (
                      <option key={factor.id} value={factor.id}>
                        {factor.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="mfa-code">
                  Authenticator code
                </label>
                <input
                  id="mfa-code"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                />
              </div>
              {error ? <p className="text-sm text-red-600">{error}</p> : null}
              <button
                type="submit"
                className="w-full bg-blue-600 text-white font-medium py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
                disabled={busy || code.trim().length === 0}
              >
                {busy ? 'Verifying…' : 'Verify'}
              </button>
            </>
          )}
        </form>
      </div>
    </main>
  );
}
