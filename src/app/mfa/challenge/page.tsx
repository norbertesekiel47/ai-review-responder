'use client';

import {
  Suspense,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, useReducedMotion } from 'motion/react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

const SUPPORT_EMAIL = 'support@repworth.net';

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

// Muted glassmorphism atmosphere — brand only, non-informational, desktop-only.
function BrandBackground() {
  return (
    <div
      className="fixed inset-0 pointer-events-none hidden lg:block"
      aria-hidden="true"
    >
      <div className="absolute top-24 left-12 w-56 h-64 bg-white/40 backdrop-blur-md rounded-3xl shadow-xl border border-white/60 p-6">
        <div className="flex gap-1 mb-3">
          {Array.from({ length: 4 }).map((_, j) => (
            <div key={j} className="size-3.5 bg-[#F2C3B9]/60 rounded-full" />
          ))}
        </div>
        <div className="space-y-2">
          <div className="h-3 bg-[#2a2a2a]/15 rounded w-full" />
          <div className="h-3 bg-[#2a2a2a]/15 rounded w-5/6" />
          <div className="h-3 bg-[#2a2a2a]/15 rounded w-4/6" />
        </div>
      </div>
      <div className="absolute bottom-24 right-16 w-60 h-56 bg-white/40 backdrop-blur-md rounded-3xl shadow-xl border border-white/60 p-6">
        <div className="flex gap-1 mb-3">
          {Array.from({ length: 5 }).map((_, j) => (
            <div key={j} className="size-3.5 bg-[#97B3AE]/50 rounded-full" />
          ))}
        </div>
        <div className="space-y-2">
          <div className="h-3 bg-[#2a2a2a]/15 rounded w-full" />
          <div className="h-3 bg-[#2a2a2a]/15 rounded w-3/4" />
        </div>
      </div>
    </div>
  );
}

// Sage page + centered white island card. No overflow-hidden (iOS Safari rule).
function MfaShell({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <main className="min-h-screen bg-[#D2E0D3] relative flex items-center justify-center px-4 py-16">
      <BrandBackground />
      <motion.div
        className="relative z-10 w-full max-w-md bg-white rounded-[3rem] shadow-2xl p-8 sm:p-10"
        initial={reduce ? false : { opacity: 0, y: 24, scale: 0.97 }}
        animate={reduce ? undefined : { opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      >
        <div className="flex items-center gap-2 mb-8">
          <div className="size-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
          <span className="text-sm tracking-wider uppercase text-[#97B3AE]">
            RepWorth
          </span>
        </div>
        {children}
      </motion.div>
    </main>
  );
}

export function MfaChallengeForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const reduce = useReducedMotion();
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
    <MfaShell>
      <h1 className="text-2xl sm:text-3xl font-medium text-[#2a2a2a] mb-2">
        Verify it&apos;s you
      </h1>
      <p className="text-[#6a6a6a] mb-6 leading-relaxed">
        Enter the 6-digit code from your authenticator app to finish signing in.
      </p>

      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}

      {loading ? (
        <p aria-live="polite" className="text-[#6a6a6a]">
          Loading your security options…
        </p>
      ) : factors.length === 0 ? (
        <div className="space-y-4">
          {!error ? (
            <p className="text-[#6a6a6a] leading-relaxed">
              No verified authenticator is available for this account.
            </p>
          ) : null}
          <div className="flex flex-col gap-2 text-sm">
            <Link
              className="text-[#97B3AE] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] rounded"
              href="/login"
            >
              Return to login
            </Link>
            <a
              className="text-[#97B3AE] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] rounded"
              href={`mailto:${SUPPORT_EMAIL}`}
            >
              Trouble signing in? Contact support
            </a>
          </div>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={(event) => void verify(event)}>
          {busy ? (
            <output className="sr-only">
              Verifying your code…
            </output>
          ) : null}
          {factors.length > 1 ? (
            <div>
              <label
                className="block text-sm font-medium text-[#2a2a2a] mb-1.5"
                htmlFor="mfa-factor"
              >
                Authenticator
              </label>
              <select
                id="mfa-factor"
                className="w-full rounded-xl border border-[#97B3AE]/30 bg-white px-4 py-3 text-base text-[#2a2a2a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]"
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
            <label
              className="block text-sm font-medium text-[#2a2a2a] mb-1.5"
              htmlFor="mfa-code"
            >
              Authenticator code
            </label>
            <input
              id="mfa-code"
              className="w-full rounded-xl border border-[#97B3AE]/30 bg-white px-4 py-3 text-base text-[#2a2a2a] tracking-[0.3em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              required
            />
          </div>
          <motion.button
            type="submit"
            className="w-full rounded-full bg-[#97B3AE] px-8 py-4 font-medium text-white shadow-lg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] focus-visible:ring-offset-2"
            whileHover={reduce ? undefined : { scale: 1.03, y: -2 }}
            whileTap={reduce ? undefined : { scale: 0.98 }}
            disabled={busy || code.trim().length === 0}
          >
            {busy ? 'Verifying…' : 'Verify'}
          </motion.button>
          <a
            className="block text-center text-sm text-[#97B3AE] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] rounded"
            href={`mailto:${SUPPORT_EMAIL}`}
          >
            Trouble signing in? Contact support
          </a>
        </form>
      )}
    </MfaShell>
  );
}

// useSearchParams requires a Suspense boundary during prerender/CSR bailout.
export default function MfaChallengePage() {
  return (
    <Suspense
      fallback={
        <MfaShell>
          <h1 className="text-2xl sm:text-3xl font-medium text-[#2a2a2a] mb-2">
            Verify it&apos;s you
          </h1>
          <p aria-live="polite" className="text-[#6a6a6a]">
            Loading…
          </p>
        </MfaShell>
      }
    >
      <MfaChallengeForm />
    </Suspense>
  );
}
