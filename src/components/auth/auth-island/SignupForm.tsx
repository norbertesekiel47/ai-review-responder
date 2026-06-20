'use client';

import { useEffect, useId, useMemo, useReducer, useState } from 'react';
import Link from 'next/link';
import { PREFILL_EMAIL_KEY } from '@/components/auth/shared/prefillEmail';
import { useSignupSubmit } from '@/components/auth/hooks/useSignupSubmit';
import { useGoogleOAuth } from '@/components/auth/hooks/useGoogleOAuth';
import {
  passwordRequirements,
  strengthOf,
  STRENGTH_LABELS,
} from '@/components/auth/shared/strength';
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

interface SignupFormState {
  name: string;
  phone: string;
  email: string;
  pwd: string;
  agree: boolean;
}

const initialSignupFormState: SignupFormState = {
  name: '',
  phone: '',
  email: '',
  pwd: '',
  agree: false,
};

type SignupFormAction =
  | { type: 'setName'; name: string }
  | { type: 'setPhone'; phone: string }
  | { type: 'setEmail'; email: string }
  | { type: 'setPwd'; pwd: string }
  | { type: 'setAgree'; agree: boolean };

function signupFormReducer(state: SignupFormState, action: SignupFormAction): SignupFormState {
  switch (action.type) {
    case 'setName':
      return { ...state, name: action.name };
    case 'setPhone':
      return { ...state, phone: action.phone };
    case 'setEmail':
      return { ...state, email: action.email };
    case 'setPwd':
      return { ...state, pwd: action.pwd };
    case 'setAgree':
      return { ...state, agree: action.agree };
  }
}

export function SignupForm() {
  const [form, dispatch] = useReducer(signupFormReducer, initialSignupFormState);
  const { name, phone, email, pwd, agree } = form;
  // Hint shown only after the owner tries to submit without accepting Terms,
  // so the disabled CTA isn't a silent dead end.
  const [termsHint, setTermsHint] = useState(false);

  const reqListId = useId();
  const strengthMsgId = useId();
  const termsHintId = useId();

  // Carry an email typed on the sibling (login) screen across the tab switch,
  // via sessionStorage so it never rides in the URL. Cleared on read.
  useEffect(() => {
    if (typeof sessionStorage === 'undefined') return;
    const stored = sessionStorage.getItem(PREFILL_EMAIL_KEY);
    if (stored) {
      dispatch({ type: 'setEmail', email: stored });
      sessionStorage.removeItem(PREFILL_EMAIL_KEY);
    }
  }, []);

  const { submit, loading, error, errorKind } = useSignupSubmit();
  const oauth = useGoogleOAuth({ flow: 'owner', next: '/signup/finish' });
  const displayError = error || oauth.error;

  const strength = useMemo(() => strengthOf(pwd), [pwd]);
  const requirements = useMemo(() => passwordRequirements(pwd), [pwd]);

  // De-noise the screen-reader strength announcement: instead of firing on every
  // keystroke, settle on the latest label after the owner pauses typing. The
  // setState lives inside the (async) timeout callback, never the effect body.
  const [announcedStrength, setAnnouncedStrength] = useState('');
  useEffect(() => {
    const id = setTimeout(() => {
      setAnnouncedStrength(pwd ? STRENGTH_LABELS[Math.min(strength, 4)] ?? '' : '');
    }, 600);
    return () => clearTimeout(id);
  }, [pwd, strength]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    if (!agree) {
      setTermsHint(true);
      return;
    }
    void captureSignupStarted('email');
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
        onClick={() => {
          void captureSignupStarted('google');
          void oauth.start();
        }}
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
            onChange={(e) => dispatch({ type: 'setName', name: e.target.value })}
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
            onChange={(e) => dispatch({ type: 'setPhone', phone: e.target.value })}
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
        onChange={(e) => dispatch({ type: 'setEmail', email: e.target.value })}
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
        onChange={(e) => dispatch({ type: 'setPwd', pwd: e.target.value })}
        required
        minLength={8}
        describedById={`${reqListId} ${strengthMsgId}`}
      />

      <ul className="rw-req-list" id={reqListId} aria-label="Password requirements">
        {requirements.map((req) => (
          <li key={req.label} className={req.met ? 'met' : ''}>
            {req.label}
            <span className="rw-sr-only">{req.met ? ' (met)' : ' (not yet met)'}</span>
          </li>
        ))}
      </ul>

      <div className="rw-strength" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`rw-strength-bar ${strength >= i ? `lit-${Math.min(strength, 4)}` : ''}`}
          />
        ))}
      </div>
      <div className="rw-strength-label" aria-hidden="true">
        {pwd ? STRENGTH_LABELS[Math.min(strength, 4)] : 'Pick something memorable but tough.'}
      </div>
      {/* Single debounced live region so SRs hear strength once typing settles,
          not on every keystroke. The visible label above is decorative. */}
      <div id={strengthMsgId} className="rw-sr-only" aria-live="polite">
        {announcedStrength ? `Password strength: ${announcedStrength}` : ''}
      </div>

      {displayError && (
        <p className="rw-alert" role="alert">
          {displayError}
          {showAccountExists && (
            <>
              {' '}
              <Link
                className="rw-link"
                href="/login"
                onClick={() => {
                  if (typeof sessionStorage !== 'undefined') {
                    sessionStorage.setItem(PREFILL_EMAIL_KEY, email.trim().toLowerCase());
                  }
                }}
              >
                Sign in
              </Link>
            </>
          )}
        </p>
      )}

      <div className="rw-agree" style={{ marginTop: 18, marginBottom: termsHint ? 6 : 18 }}>
        {/* Links live OUTSIDE the <label> so they aren't nested interactive
            content (clicking a link must not toggle the checkbox). The label
            text wraps only the checkbox + its caption. */}
        <label className="rw-check">
          <input
            type="checkbox"
            checked={agree}
            onChange={(e) => {
              dispatch({ type: 'setAgree', agree: e.target.checked });
              if (e.target.checked) setTermsHint(false);
            }}
            aria-describedby={termsHint ? termsHintId : undefined}
          />
          <span className="box">
            <CheckIcon />
          </span>
          <span className="rw-agree-text">I agree to the</span>
        </label>{' '}
        <Link className="rw-link" href="/legal/terms">
          Terms
        </Link>
        <span className="rw-agree-sep">&nbsp;&amp;&nbsp;</span>
        <Link className="rw-link" href="/legal/privacy">
          Privacy
        </Link>
      </div>
      {termsHint && !agree && (
        <p id={termsHintId} className="rw-form-hint" role="alert">
          Please accept the Terms &amp; Privacy to continue.
        </p>
      )}

      <button
        type="submit"
        className={`rw-submit ${loading ? 'is-loading' : ''}`}
        disabled={loading}
        aria-disabled={!agree || undefined}
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

async function captureSignupStarted(method: 'email' | 'google') {
  await fetch('/api/analytics/enqueue', {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventName: 'signup_started',
      clientEventId: makeClientEventId(),
      properties: { source: 'signup_form', method },
    }),
  }).catch(() => undefined);
}

function makeClientEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
