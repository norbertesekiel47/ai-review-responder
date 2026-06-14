'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PREFILL_EMAIL_KEY } from '@/components/auth/shared/prefillEmail';
import { useLoginSubmit } from '@/components/auth/hooks/useLoginSubmit';
import { useGoogleOAuth } from '@/components/auth/hooks/useGoogleOAuth';
import { mapInitialQueryError } from '@/components/auth/shared/mapLoginError';
import { Field } from './Field';
import { ArrowIcon, GoogleIcon, LockIcon, MailIcon } from './Icons';

export function LoginForm() {
  // useSearchParams() opts the whole route into client rendering unless it sits
  // under a Suspense boundary, so the param-reading body lives in LoginFormInner.
  return (
    <Suspense fallback={<div className="rw-stagger" aria-hidden="true" />}>
      <LoginFormInner />
    </Suspense>
  );
}

function LoginFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(() => searchParams.get('email') ?? '');
  const [password, setPassword] = useState('');

  // Carry the email from a prior signup→login handoff via sessionStorage so it
  // never appears in the URL/history/logs. Also strip any ?email= legacy param
  // (e.g., a pasted recovery link) once we've read it.
  useEffect(() => {
    if (typeof sessionStorage !== 'undefined') {
      const stored = sessionStorage.getItem(PREFILL_EMAIL_KEY);
      if (stored) {
        // sessionStorage is browser-only (undefined during SSR), so this prefill
        // read can't be a lazy initializer — it must happen in an effect.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEmail(stored);
        sessionStorage.removeItem(PREFILL_EMAIL_KEY);
      }
    }
    if (searchParams.get('email')) {
      const next = new URLSearchParams(searchParams.toString());
      next.delete('email');
      const qs = next.toString();
      router.replace(qs ? `/login?${qs}` : '/login');
    }
    // exhaustive-deps: mount-only — apply the one-time email prefill and strip the
    // ?email query param once on load; intentionally not re-run when searchParams/
    // router identities change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { submit, loading, error, setError } = useLoginSubmit({
    portal: 'owner',
    allowedRoles: ['owner'],
    defaultRoute: '/dashboard',
  });
  // Existing owners are routed to /dashboard by the callback once their
  // users row is found. New Google identities need /signup/finish so the app
  // can create the public users/accounts rows after Supabase creates auth.users.
  const oauth = useGoogleOAuth({ flow: 'owner', next: '/signup/finish' });

  const initialQueryError = mapInitialQueryError(searchParams.get('error'));
  const displayError = error || oauth.error || initialQueryError;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    await submit(email, password, searchParams.get('from') ?? '');
  }

  return (
    <form onSubmit={handleSubmit} className="rw-stagger" autoComplete="on">
      <button
        type="button"
        className="rw-google-btn"
        onClick={() => void oauth.start()}
        disabled={oauth.loading || loading}
      >
        <GoogleIcon /> {oauth.loading ? 'Redirecting to Google…' : 'Continue with Google'}
      </button>
      <div className="rw-divider">or with email</div>

      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@yourshop.com"
        icon={<MailIcon />}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        placeholder="••••••••"
        icon={<LockIcon />}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />

      {displayError && (
        <p className="rw-alert" role="alert">
          {displayError}
        </p>
      )}

      <div className="rw-row-end">
        <Link className="rw-link" href="/forgot-password">
          Forgot password?
        </Link>
      </div>

      <button
        type="submit"
        className={`rw-submit ${loading ? 'is-loading' : ''}`}
        disabled={loading}
      >
        <span className="label">
          {loading ? (
            <>
              <span className="rw-spinner" /> Signing in…
            </>
          ) : (
            <>
              Sign in{' '}
              <span className="arrow">
                <ArrowIcon />
              </span>
            </>
          )}
        </span>
      </button>
    </form>
  );
}
