'use client';

import type { FormEvent } from 'react';
import { useReducer, useRef } from 'react';
import { LazyMotion, domAnimation, m } from 'motion/react';
import Link from 'next/link';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { LEAD_INTAKE_HONEYPOT_FIELD } from '@/lib/shared/schemas';
import {
  firstInvalidField,
  getLeadIntakeFieldErrorProps,
  hasFieldErrors,
  submitLeadIntake,
  validateLeadIntakeFields,
} from './LeadIntakeForm.helpers';

export type LeadIntent = 'waitlist' | 'demo';
export type LeadSource =
  | 'landing'
  | 'features'
  | 'how-it-works'
  | 'book-a-demo'
  | 'pricing'
  | 'unknown';

type FormState = 'idle' | 'loading' | 'success' | 'error';
export type RequiredLeadIntakeField = 'name' | 'email' | 'businessName';
export type LeadIntakeField = RequiredLeadIntakeField | 'googleMapsUrl';
export type LeadIntakeFieldErrors = Partial<Record<LeadIntakeField, string>>;

export interface LeadIntakePayload {
  name: string;
  email: string;
  businessName: string;
  googleMapsUrl: string;
  intent: LeadIntent;
  source: LeadSource;
  // Hidden honeypot value; sent under its canonical server field name by
  // submitLeadIntake so the server-side bot check can actually fire.
  honeypot: string;
}

type LeadIntakeCopy = Partial<{
  button: string;
  loading: string;
  successHeading: string;
  successBody: string;
}>;

type LeadIntakeFormProps = {
  intent: LeadIntent;
  source: LeadSource;
  tone?: 'onTeal' | 'light';
  copy?: LeadIntakeCopy;
};

const DEFAULT_COPY = {
  button: 'Join waitlist',
  loading: 'Joining...',
  successHeading: "You're on the waitlist.",
  successBody: "We'll reach out when early access opens for your area.",
};

const HONEYPOT_FIELD_NAME = LEAD_INTAKE_HONEYPOT_FIELD;

const TONE_STYLES = {
  onTeal: {
    form: 'max-w-md mx-auto space-y-4',
    label: 'block text-sm font-medium text-white mb-1.5',
    input:
      'w-full rounded-lg bg-white/20 border border-white/40 px-4 py-3 text-white placeholder-white/80 focus:outline-none focus:ring-2 focus:ring-white/60 transition-all aria-[invalid=true]:border-white aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-white/70',
    required: 'text-white',
    error: 'mt-1.5 text-sm font-medium text-white',
    button:
      'w-full px-10 py-4 bg-white text-rw-teal-strong rounded-full shadow-xl font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-opacity inline-flex items-center justify-center gap-2',
    spinner: 'text-rw-teal-strong',
    consent: 'mt-3 text-center text-xs text-white/90',
    consentLink: 'underline underline-offset-2 hover:text-white',
    success:
      'rounded-2xl bg-white/10 border border-white/30 p-8 text-center',
    successHeading: 'text-2xl text-white mb-2',
    successBody: 'text-white/90',
    hoverShadow: '0 20px 40px rgba(0,0,0,0.2)',
  },
  light: {
    form: 'space-y-4',
    label: 'block text-sm font-medium text-rw-ink mb-1.5',
    input:
      'w-full rounded-lg bg-rw-cream/50 border border-rw-teal/30 px-4 py-3 text-rw-ink placeholder-rw-ink-soft focus:outline-none focus:ring-2 focus:ring-rw-teal-strong/40 transition-all text-sm aria-[invalid=true]:border-rw-error aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-rw-error/30',
    required: 'text-rw-error',
    error: 'mt-1.5 text-sm font-medium text-rw-error',
    button:
      'w-full px-8 py-4 bg-rw-teal-strong text-white rounded-full shadow-lg font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-opacity inline-flex items-center justify-center gap-2',
    spinner: 'text-white',
    consent: 'mt-3 text-center text-xs text-rw-ink-soft',
    consentLink: 'underline underline-offset-2 text-rw-teal-strong hover:text-rw-teal-strong/80',
    success:
      'rounded-2xl bg-white border border-rw-teal/20 shadow-lg p-8 text-center',
    successHeading: 'text-2xl text-rw-ink font-medium mb-2',
    successBody: 'text-rw-ink-soft',
    hoverShadow: '0 20px 40px rgba(151,179,174,0.3)',
  },
};

interface LeadIntakeState {
  name: string;
  email: string;
  businessName: string;
  googleMapsUrl: string;
  honeypot: string;
  state: FormState;
  errorMsg: string;
  fieldErrors: LeadIntakeFieldErrors;
}

const initialLeadIntakeState: LeadIntakeState = {
  name: '',
  email: '',
  businessName: '',
  googleMapsUrl: '',
  honeypot: '',
  state: 'idle',
  errorMsg: '',
  fieldErrors: {},
};

type LeadIntakeAction =
  | { type: 'setName'; name: string }
  | { type: 'setEmail'; email: string }
  | { type: 'setBusinessName'; businessName: string }
  | { type: 'setGoogleMapsUrl'; googleMapsUrl: string }
  | { type: 'setHoneypot'; honeypot: string }
  | { type: 'validationFailed'; fieldErrors: LeadIntakeFieldErrors }
  | { type: 'submitStart' }
  | { type: 'submitSuccess' }
  | { type: 'submitError'; errorMsg: string };

// Flat one-case-per-action switch; cyclomatic count is the action vocabulary.
// fallow-ignore-next-line complexity
function leadIntakeReducer(state: LeadIntakeState, action: LeadIntakeAction): LeadIntakeState {
  switch (action.type) {
    case 'setName':
      return { ...state, name: action.name };
    case 'setEmail':
      return { ...state, email: action.email };
    case 'setBusinessName':
      return { ...state, businessName: action.businessName };
    case 'setGoogleMapsUrl':
      return { ...state, googleMapsUrl: action.googleMapsUrl };
    case 'setHoneypot':
      return { ...state, honeypot: action.honeypot };
    case 'validationFailed':
      return { ...state, fieldErrors: action.fieldErrors, errorMsg: '', state: 'error' };
    case 'submitStart':
      return { ...state, state: 'loading', errorMsg: '', fieldErrors: {} };
    case 'submitSuccess':
      return { ...state, state: 'success' };
    case 'submitError':
      return { ...state, errorMsg: action.errorMsg, fieldErrors: {}, state: 'error' };
  }
}

export function LeadIntakeForm({
  intent,
  source,
  tone = 'onTeal',
  copy,
}: LeadIntakeFormProps) {
  const resolvedCopy = { ...DEFAULT_COPY, ...copy };
  const styles = TONE_STYLES[tone];
  const prefersReducedMotion = usePrefersReducedMotion();
  const fieldPrefix = `lead-intake-${intent}-${source}`;
  const fieldId = (field: LeadIntakeField) => `${fieldPrefix}-${field}`;
  const errorId = (field: LeadIntakeField) => `${fieldId(field)}-error`;
  const formErrorId = `${fieldPrefix}-form-error`;

  // One ref holding a record of the input elements, populated via callback refs
  // below. Avoids reading ref `.current` during render (react-hooks/refs); the
  // record is only read in the submit handler to focus the first invalid field.
  const fieldRefs = useRef<Record<LeadIntakeField, HTMLInputElement | null>>({
    name: null,
    email: null,
    businessName: null,
    googleMapsUrl: null,
  });

  const [formState, dispatch] = useReducer(leadIntakeReducer, initialLeadIntakeState);
  const {
    name,
    email,
    businessName,
    googleMapsUrl,
    honeypot,
    state,
    errorMsg,
    fieldErrors,
  } = formState;
  const isLoading = state === 'loading';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const validationErrors = validateLeadIntakeFields({
      name,
      email,
      businessName,
      googleMapsUrl,
    });
    if (hasFieldErrors(validationErrors)) {
      dispatch({ type: 'validationFailed', fieldErrors: validationErrors });
      const focusField = firstInvalidField(validationErrors);
      if (focusField) fieldRefs.current[focusField]?.focus();
      return;
    }

    dispatch({ type: 'submitStart' });

    try {
      const res = await submitLeadIntake({
        name: name.trim(),
        email: email.trim(),
        businessName: businessName.trim(),
        googleMapsUrl: googleMapsUrl.trim(),
        intent,
        source,
        honeypot,
      });

      if (res.ok) {
        dispatch({ type: 'submitSuccess' });
      } else {
        const data = await res.json().catch(() => ({}));
        dispatch({
          type: 'submitError',
          errorMsg: (data as { error?: string }).error ?? 'Something went wrong. Please try again.',
        });
      }
    } catch {
      dispatch({
        type: 'submitError',
        errorMsg: 'Network error. Please check your connection and try again.',
      });
    }
  };

  if (state === 'success') {
    return (
      <LazyMotion features={domAnimation}>
        <m.div
          initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className={styles.success}
        >
          <h3 className={styles.successHeading}>{resolvedCopy.successHeading}</h3>
          <p className={styles.successBody}>{resolvedCopy.successBody}</p>
        </m.div>
      </LazyMotion>
    );
  }

  const renderError = (field: LeadIntakeField) =>
    fieldErrors[field] ? (
      <p id={errorId(field)} className={styles.error}>
        {fieldErrors[field]}
      </p>
    ) : null;

  return (
    <LazyMotion features={domAnimation}>
      <form onSubmit={handleSubmit} noValidate className={styles.form}>
        <input type="hidden" name="intent" value={intent} readOnly />
        <input type="hidden" name="source" value={source} readOnly />

        {/* Honeypot: hidden from real users; bots that auto-fill it are rejected
            server-side. Kept off-screen (not display:none) so headless bots that
            skip hidden inputs still see it. */}
        <div aria-hidden="true" className="absolute left-[-9999px] top-[-9999px] h-0 w-0 overflow-hidden">
          <label htmlFor={fieldId('googleMapsUrl') + '-hp'}>Company website</label>
          <input
            id={fieldId('googleMapsUrl') + '-hp'}
            type="text"
            name={HONEYPOT_FIELD_NAME}
            value={honeypot}
            onChange={(e) => dispatch({ type: 'setHoneypot', honeypot: e.target.value })}
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        <div>
          <label htmlFor={fieldId('name')} className={styles.label}>
            Your name <span className={styles.required} aria-hidden="true">*</span>
          </label>
          <input
            ref={(el) => { fieldRefs.current.name = el; }}
            id={fieldId('name')}
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => dispatch({ type: 'setName', name: e.target.value })}
            disabled={isLoading}
            className={styles.input}
            autoComplete="name"
            aria-required="true"
            {...getLeadIntakeFieldErrorProps('name', fieldErrors, errorId('name'))}
            name="name"
          />
          {renderError('name')}
        </div>

        <div>
          <label htmlFor={fieldId('email')} className={styles.label}>
            Email address <span className={styles.required} aria-hidden="true">*</span>
          </label>
          <input
            ref={(el) => { fieldRefs.current.email = el; }}
            id={fieldId('email')}
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => dispatch({ type: 'setEmail', email: e.target.value })}
            disabled={isLoading}
            className={styles.input}
            autoComplete="email"
            aria-required="true"
            {...getLeadIntakeFieldErrorProps('email', fieldErrors, errorId('email'))}
            name="email"
          />
          {renderError('email')}
        </div>

        <div>
          <label htmlFor={fieldId('businessName')} className={styles.label}>
            Business name <span className={styles.required} aria-hidden="true">*</span>
          </label>
          <input
            ref={(el) => { fieldRefs.current.businessName = el; }}
            id={fieldId('businessName')}
            type="text"
            placeholder="Business name"
            value={businessName}
            onChange={(e) => dispatch({ type: 'setBusinessName', businessName: e.target.value })}
            disabled={isLoading}
            className={styles.input}
            autoComplete="organization"
            aria-required="true"
            {...getLeadIntakeFieldErrorProps('businessName', fieldErrors, errorId('businessName'))}
            name="businessName"
          />
          {renderError('businessName')}
        </div>

        <div>
          <label htmlFor={fieldId('googleMapsUrl')} className={styles.label}>
            Google Maps link <span className="font-normal opacity-80">(optional)</span>
          </label>
          <input
            ref={(el) => { fieldRefs.current.googleMapsUrl = el; }}
            id={fieldId('googleMapsUrl')}
            type="url"
            inputMode="url"
            placeholder="https://maps.google.com/... (helps us prep)"
            value={googleMapsUrl}
            onChange={(e) => dispatch({ type: 'setGoogleMapsUrl', googleMapsUrl: e.target.value })}
            disabled={isLoading}
            className={styles.input}
            autoComplete="url"
            {...getLeadIntakeFieldErrorProps('googleMapsUrl', fieldErrors, errorId('googleMapsUrl'))}
            name="googleMapsUrl"
          />
          {renderError('googleMapsUrl')}
        </div>

        {state === 'error' && errorMsg && (
          <p id={formErrorId} role="alert" className={styles.error}>{errorMsg}</p>
        )}

        <m.button
          type="submit"
          disabled={isLoading}
          aria-busy={isLoading}
          whileHover={prefersReducedMotion ? undefined : { scale: 1.05, y: -2, boxShadow: styles.hoverShadow }}
          whileTap={prefersReducedMotion ? undefined : { scale: 0.98 }}
          className={styles.button}
        >
          {isLoading && (
            <svg
              className={`size-4 animate-spin ${styles.spinner}`}
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          )}
          {isLoading ? resolvedCopy.loading : resolvedCopy.button}
        </m.button>

        <p className={styles.consent}>
          By joining you agree to our{' '}
          <Link href="/legal/privacy" className={styles.consentLink}>
            Privacy Policy
          </Link>
          .
        </p>
      </form>
    </LazyMotion>
  );
}
