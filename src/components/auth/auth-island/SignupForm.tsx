'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PREFILL_EMAIL_KEY } from '@/components/auth/shared/prefillEmail';
import { useSignupSubmit } from '@/components/auth/hooks/useSignupSubmit';
import { useGoogleOAuth } from '@/components/auth/hooks/useGoogleOAuth';
import { strengthOf, STRENGTH_LABELS } from '@/components/auth/shared/strength';
import { fireConfetti } from './fireConfetti';
import { Field } from './Field';
import {
  ArrowIcon,
  CheckIcon,
  GoogleIcon,
  LockIcon,
  MailIcon,
  PhoneIcon,
  SparkleIcon,
  UserIcon,
} from './Icons';

export function SignupForm() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [pwd, setPwd] = useState('');
  const [agree, setAgree] = useState(false);

  const router = useRouter();
  const { submit, loading, error, errorKind } = useSignupSubmit();
  const oauth = useGoogleOAuth({ flow: 'owner', next: '/signup/finish' });
  const displayError = error || oauth.error;

  const strength = useMemo(() => strengthOf(pwd), [pwd]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agree || loading) return;
    const result = await submit({
      ownerEmail: email,
      ownerName: name,
      ownerPhone: phone,
      password: pwd,
    });
    if (result.ok) {
      // Success path: submit() has already issued router.push(). Confetti is
      // fired defensively for the rare case where the navigation hasn't
      // visually unmounted us yet (e.g., MOCK_EXTERNAL_APIS in dev).
      fireConfetti();
    }
  }

  const showAccountExists = errorKind === 'account_exists';

  return (
    <form onSubmit={handleSubmit} className="rw-stagger" autoComplete="on">
      <button
        type="button"
        className="rw-google-btn"
        onClick={() => void oauth.start()}
        disabled={oauth.loading || loading}
      >
        <GoogleIcon /> {oauth.loading ? 'Redirecting to Google…' : 'Sign up with Google'}
      </button>
      <div className="rw-divider">or with email</div>

      <div className="rw-field-row">
        <div className="row">
          <Field
            label="Your name"
            name="name"
            type="text"
            autoComplete="name"
            placeholder="Sofia Reyes"
            icon={<UserIcon />}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Field
            label="Phone (optional)"
            name="phone"
            type="tel"
            autoComplete="tel"
            placeholder="+1 555 0136"
            icon={<PhoneIcon />}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
      </div>

      <Field
        label="Work email"
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
        label="Create a password"
        name="password"
        type="password"
        autoComplete="new-password"
        placeholder="At least 8 characters"
        icon={<LockIcon />}
        value={pwd}
        onChange={(e) => setPwd(e.target.value)}
        required
        minLength={8}
      />

      <div className="rw-strength" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`rw-strength-bar ${strength >= i ? `lit-${Math.min(strength, 4)}` : ''}`}
          />
        ))}
      </div>
      <div className="rw-strength-label" aria-live="polite">
        {pwd ? STRENGTH_LABELS[Math.min(strength, 4)] : 'Pick something memorable but tough.'}
      </div>

      {displayError && (
        <p className="rw-alert" role="alert">
          {displayError}
          {showAccountExists && (
            <>
              {' '}
              <a
                className="rw-link"
                href="/login"
                onClick={(e) => {
                  e.preventDefault();
                  if (typeof sessionStorage !== 'undefined') {
                    sessionStorage.setItem(PREFILL_EMAIL_KEY, email.trim().toLowerCase());
                  }
                  router.replace('/login');
                }}
              >
                Sign in
              </a>
            </>
          )}
        </p>
      )}

      <div className="rw-row-between" style={{ marginTop: 18, marginBottom: 18 }}>
        <label className="rw-check">
          <input
            type="checkbox"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
          />
          <span className="box">
            <CheckIcon />
          </span>
          I agree to the{' '}
          <a className="rw-link" style={{ marginLeft: 4 }} href="/legal/terms">
            Terms
          </a>
          &nbsp;&amp;&nbsp;
          <a className="rw-link" href="/legal/privacy">
            Privacy
          </a>
        </label>
      </div>

      <button
        type="submit"
        className={`rw-submit ${loading ? 'is-loading' : ''}`}
        disabled={loading || !agree}
      >
        <span className="label">
          {loading ? (
            <>
              <span className="rw-spinner" /> Creating your account…
            </>
          ) : (
            <>
              <SparkleIcon width={18} height={18} /> Start saving 15 hours{' '}
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
