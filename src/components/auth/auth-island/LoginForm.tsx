'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLoginSubmit } from '@/components/auth/hooks/useLoginSubmit';
import { useGoogleOAuth } from '@/components/auth/hooks/useGoogleOAuth';
import { mapInitialQueryError } from '@/components/auth/shared/mapLoginError';
import { Field } from './Field';
import { ArrowIcon, CheckIcon, GoogleIcon, LockIcon, MailIcon } from './Icons';

export function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(() => searchParams.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);

  const { submit, loading, error, setError } = useLoginSubmit({
    portal: 'owner',
    allowedRoles: ['owner'],
    defaultRoute: '/dashboard',
  });
  const oauth = useGoogleOAuth({ flow: 'owner', next: '/dashboard' });

  const initialQueryError = mapInitialQueryError(searchParams.get('error'));
  const displayError = error || oauth.error || initialQueryError;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    await submit(email, password);
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

      <div className="rw-row-between">
        <label className="rw-check">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span className="box">
            <CheckIcon />
          </span>
          Keep me signed in
        </label>
        <a className="rw-link" href="/forgot-password">
          Forgot password?
        </a>
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
