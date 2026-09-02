'use client';

import {
  Suspense,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type FormEvent,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { m, useReducedMotion } from 'motion/react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import { AuthCardShell } from '@/components/auth/AuthCardShell';
import { normalizeChallengeFactors, type ChallengeFactor } from '@/lib/auth/mfa';

const SUPPORT_EMAIL = 'support@repworth.net';

// Owner-facing copy in the page's own words — "security check", "authenticator
// app", "code". "MFA", "factor" and "challenge" are our nouns, not theirs.
const MFA_COPY = {
  loadFailed: "Couldn't load your authenticator options. Reload the page to try again.",
  challengeOffline: "Couldn't start the security check. Check your connection and try again.",
  challengeFailed: "Couldn't start the security check. Please try again.",
  tooManyAttempts: 'Too many code attempts. Try again in a few minutes.',
  verifyOffline: "Couldn't check your code. Check your connection and try again.",
  codeRejected: "That code wasn't accepted. Enter the current code from your authenticator app.",
} as const;

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
            <div key={j} className="size-3.5 bg-rw-peach/60 rounded-full" />
          ))}
        </div>
        <div className="space-y-2">
          <div className="h-3 bg-rw-ink/15 rounded w-full" />
          <div className="h-3 bg-rw-ink/15 rounded w-5/6" />
          <div className="h-3 bg-rw-ink/15 rounded w-4/6" />
        </div>
      </div>
      <div className="absolute bottom-24 right-16 w-60 h-56 bg-white/40 backdrop-blur-md rounded-3xl shadow-xl border border-white/60 p-6">
        <div className="flex gap-1 mb-3">
          {Array.from({ length: 5 }).map((_, j) => (
            <div key={j} className="size-3.5 bg-rw-teal/50 rounded-full" />
          ))}
        </div>
        <div className="space-y-2">
          <div className="h-3 bg-rw-ink/15 rounded w-full" />
          <div className="h-3 bg-rw-ink/15 rounded w-3/4" />
        </div>
      </div>
    </div>
  );
}

interface MfaState {
  factors: ChallengeFactor[];
  selectedFactorId: string;
  challengeId: string | null;
  code: string;
  loading: boolean;
  busy: boolean;
  error: string | null;
}

const initialMfaState: MfaState = {
  factors: [],
  selectedFactorId: '',
  challengeId: null,
  code: '',
  loading: true,
  busy: false,
  error: null,
};

type MfaAction =
  | { type: 'loadStart' }
  | { type: 'loadError'; error: string }
  | { type: 'loadSuccess'; factors: ChallengeFactor[]; selectedFactorId: string }
  | { type: 'selectFactor'; selectedFactorId: string }
  | { type: 'setCode'; code: string }
  | { type: 'setChallengeId'; challengeId: string | null }
  | { type: 'setError'; error: string | null }
  // A rejected code: show why, drop the stale challenge, and clear the digits
  // so the owner types a fresh code instead of editing the wrong one.
  | { type: 'rejectCode'; error: string }
  | { type: 'verifyStart' }
  | { type: 'verifyEnd' };

function mfaReducer(state: MfaState, action: MfaAction): MfaState {
  switch (action.type) {
    case 'loadStart':
      return { ...state, loading: true, error: null };
    case 'loadError':
      return { ...state, error: action.error, loading: false };
    case 'loadSuccess':
      return {
        ...state,
        factors: action.factors,
        selectedFactorId: action.selectedFactorId,
        loading: false,
      };
    case 'selectFactor':
      return { ...state, selectedFactorId: action.selectedFactorId, challengeId: null };
    case 'setCode':
      return { ...state, code: action.code };
    case 'setChallengeId':
      return { ...state, challengeId: action.challengeId };
    case 'setError':
      return { ...state, error: action.error };
    case 'rejectCode':
      return { ...state, error: action.error, challengeId: null, code: '' };
    case 'verifyStart':
      return { ...state, busy: true, error: null };
    case 'verifyEnd':
      return { ...state, busy: false };
    default:
      return state;
  }
}

// Most of the branching is JSX: three mutually exclusive render states
// (loading / no-factor dead-end / form), a conditional factor picker, and
// the challenge/verify status handling inline. Pre-existing on main; this
// branch only wired the shared normalizeChallengeFactors import through it,
// unchanged in shape.
// fallow-ignore-next-line complexity
export function MfaChallengeForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const reduce = useReducedMotion();
  const [state, dispatch] = useReducer(mfaReducer, initialMfaState);
  const { factors, selectedFactorId, challengeId, code, loading, busy, error } = state;
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Every rejected code lands here: the digits are wrong or stale either way,
  // so wipe them and put the cursor back where the next attempt starts.
  function rejectCode(message: string) {
    dispatch({ type: 'rejectCode', error: message });
    codeInputRef.current?.focus();
  }

  useEffect(() => {
    let cancelled = false;
    async function loadFactors() {
      dispatch({ type: 'loadStart' });
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (listError) {
        dispatch({ type: 'loadError', error: MFA_COPY.loadFailed });
        return;
      }
      const nextFactors = normalizeChallengeFactors(data);
      dispatch({
        type: 'loadSuccess',
        factors: nextFactors,
        selectedFactorId: nextFactors[0]?.id ?? '',
      });
    }
    void loadFactors();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  async function ensureChallenge(factorId: string): Promise<string | null> {
    if (challengeId) return challengeId;
    let res: Response;
    try {
      res = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'challenge', factorId }),
      });
    } catch {
      dispatch({ type: 'setError', error: MFA_COPY.challengeOffline });
      return null;
    }
    if (res.status === 429) {
      dispatch({ type: 'setError', error: MFA_COPY.tooManyAttempts });
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.challengeId !== 'string') {
      dispatch({ type: 'setError', error: MFA_COPY.challengeFailed });
      return null;
    }
    dispatch({ type: 'setChallengeId', challengeId: data.challengeId });
    return data.challengeId;
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFactorId) return;
    dispatch({ type: 'verifyStart' });
    try {
      const nextChallengeId = await ensureChallenge(selectedFactorId);
      if (!nextChallengeId) return;
      let res: Response;
      try {
        res = await fetch('/api/auth/mfa/challenge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'verify',
            factorId: selectedFactorId,
            challengeId: nextChallengeId,
            code,
          }),
        });
      } catch {
        rejectCode(MFA_COPY.verifyOffline);
        return;
      }
      if (res.status === 429) {
        rejectCode(MFA_COPY.tooManyAttempts);
        return;
      }
      if (!res.ok) {
        rejectCode(MFA_COPY.codeRejected);
        return;
      }
      router.push(next);
      router.refresh();
    } finally {
      dispatch({ type: 'verifyEnd' });
    }
  }

  return (
    <AuthCardShell background={<BrandBackground />}>
      <h1 className="text-2xl sm:text-3xl font-medium text-rw-ink mb-2">
        Verify it&apos;s you
      </h1>
      <p className="text-rw-ink-soft mb-6 leading-relaxed">
        Enter the 6-digit code from your authenticator app to finish signing in.
      </p>

      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-rw-error/30 bg-rw-error/5 px-4 py-3 text-sm text-rw-error"
        >
          {error}
        </p>
      ) : null}

      {loading ? (
        <p aria-live="polite" className="text-rw-ink-soft">
          Loading your security options…
        </p>
      ) : factors.length === 0 ? (
        <div className="space-y-4">
          {!error ? (
            <p className="text-rw-ink-soft leading-relaxed">
              No verified authenticator is available for this account.
            </p>
          ) : null}
          <div className="flex flex-col gap-2 text-sm">
            <Link
              className="text-rw-teal-strong font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong rounded"
              href="/login"
            >
              Return to login
            </Link>
            <a
              className="text-rw-teal-strong font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong rounded"
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
                className="block text-sm font-medium text-rw-ink mb-1.5"
                htmlFor="mfa-factor"
              >
                Authenticator
              </label>
              <select
                id="mfa-factor"
                className="w-full rounded-xl border border-rw-teal/30 bg-white px-4 py-3 text-base text-rw-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong"
                value={selectedFactorId}
                onChange={(event) =>
                  dispatch({ type: 'selectFactor', selectedFactorId: event.target.value })
                }
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
              className="block text-sm font-medium text-rw-ink mb-1.5"
              htmlFor="mfa-code"
            >
              Authenticator code
            </label>
            <input
              id="mfa-code"
              ref={codeInputRef}
              className="w-full rounded-xl border border-rw-teal/30 bg-white px-4 py-3 text-base text-rw-ink tracking-[0.3em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong"
              value={code}
              onChange={(event) => dispatch({ type: 'setCode', code: event.target.value })}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              required
            />
          </div>
          <m.button
            type="submit"
            className="w-full rounded-full bg-rw-teal-strong px-8 py-4 font-medium text-white shadow-lg hover:bg-rw-teal-strong-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong focus-visible:ring-offset-2"
            whileHover={reduce ? undefined : { scale: 1.03, y: -2 }}
            whileTap={reduce ? undefined : { scale: 0.98 }}
            disabled={busy || code.trim().length === 0}
          >
            {busy ? 'Verifying…' : 'Verify'}
          </m.button>
          <a
            className="block text-center text-sm text-rw-teal-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong rounded"
            href={`mailto:${SUPPORT_EMAIL}`}
          >
            Trouble signing in? Contact support
          </a>
        </form>
      )}
    </AuthCardShell>
  );
}

// useSearchParams requires a Suspense boundary during prerender/CSR bailout.
export function MfaChallengeScreen() {
  return (
    <Suspense
      fallback={
        <AuthCardShell background={<BrandBackground />}>
          <h1 className="text-2xl sm:text-3xl font-medium text-rw-ink mb-2">
            Verify it&apos;s you
          </h1>
          <p aria-live="polite" className="text-rw-ink-soft">
            Loading…
          </p>
        </AuthCardShell>
      }
    >
      <MfaChallengeForm />
    </Suspense>
  );
}
