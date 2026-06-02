'use client';

import type { FormEvent } from 'react';
import { useReducer } from 'react';
import { LazyMotion, domAnimation, m } from 'motion/react';
import {
  getLeadIntakeFieldErrorProps,
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
export type InvalidLeadIntakeField = 'name' | 'email' | 'businessName';
export type LeadIntakeField = InvalidLeadIntakeField | 'googleMapsUrl';

export interface LeadIntakePayload {
  name: string;
  email: string;
  businessName: string;
  googleMapsUrl: string;
  intent: LeadIntent;
  source: LeadSource;
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

export type LeadIntakeValidationResult = {
  message: string;
  invalidField: InvalidLeadIntakeField;
} | null;

const TONE_STYLES = {
  onTeal: {
    form: 'max-w-md mx-auto space-y-4',
    input:
      'w-full rounded-lg bg-white/20 border border-white/30 px-4 py-3 text-white placeholder-white/60 focus:outline-none focus:ring-2 focus:ring-white/40 transition-all',
    error: 'text-sm text-red-200',
    button:
      'w-full px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-opacity',
    success:
      'rounded-2xl bg-white/10 border border-white/30 p-8 text-center',
    successHeading: 'text-2xl text-white mb-2',
    successBody: 'text-white/80',
    hoverShadow: '0 20px 40px rgba(0,0,0,0.2)',
  },
  light: {
    form: 'space-y-4',
    input:
      'w-full rounded-lg bg-[#F0EEEA]/50 border border-[#97B3AE]/20 px-4 py-3 text-[#2a2a2a] placeholder-[#6a6a6a]/60 focus:outline-none focus:ring-2 focus:ring-[#97B3AE]/40 transition-all text-sm',
    error: 'text-sm text-red-500',
    button:
      'w-full px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-opacity',
    success:
      'rounded-2xl bg-white border border-[#97B3AE]/20 shadow-lg p-8 text-center',
    successHeading: 'text-2xl text-[#2a2a2a] font-medium mb-2',
    successBody: 'text-[#6a6a6a]',
    hoverShadow: '0 20px 40px rgba(151,179,174,0.3)',
  },
};

interface LeadIntakeState {
  name: string;
  email: string;
  businessName: string;
  googleMapsUrl: string;
  state: FormState;
  errorMsg: string;
  invalidField: InvalidLeadIntakeField | null;
}

const initialLeadIntakeState: LeadIntakeState = {
  name: '',
  email: '',
  businessName: '',
  googleMapsUrl: '',
  state: 'idle',
  errorMsg: '',
  invalidField: null,
};

type LeadIntakeAction =
  | { type: 'setName'; name: string }
  | { type: 'setEmail'; email: string }
  | { type: 'setBusinessName'; businessName: string }
  | { type: 'setGoogleMapsUrl'; googleMapsUrl: string }
  | { type: 'validationFailed'; errorMsg: string; invalidField: InvalidLeadIntakeField }
  | { type: 'submitStart' }
  | { type: 'submitSuccess' }
  | { type: 'submitError'; errorMsg: string };

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
    case 'validationFailed':
      return { ...state, errorMsg: action.errorMsg, invalidField: action.invalidField, state: 'error' };
    case 'submitStart':
      return { ...state, state: 'loading', errorMsg: '', invalidField: null };
    case 'submitSuccess':
      return { ...state, state: 'success' };
    case 'submitError':
      return { ...state, errorMsg: action.errorMsg, invalidField: null, state: 'error' };
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
  const errorId = `lead-intake-${intent}-${source}-error`;

  const [formState, dispatch] = useReducer(leadIntakeReducer, initialLeadIntakeState);
  const { name, email, businessName, googleMapsUrl, state, errorMsg, invalidField } = formState;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const validationError = validateLeadIntakeFields({
      name,
      email,
      businessName,
    });
    if (validationError) {
      dispatch({
        type: 'validationFailed',
        errorMsg: validationError.message,
        invalidField: validationError.invalidField,
      });
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
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className={styles.success}
        >
          <h3 className={styles.successHeading}>{resolvedCopy.successHeading}</h3>
          <p className={styles.successBody}>{resolvedCopy.successBody}</p>
        </m.div>
      </LazyMotion>
    );
  }

  return (
    <LazyMotion features={domAnimation}>
      <form onSubmit={handleSubmit} noValidate className={styles.form}>
        <input type="hidden" name="intent" value={intent} readOnly />
        <input type="hidden" name="source" value={source} readOnly />
        <input
          type="text"
          placeholder="Your name"
          value={name}
          onChange={(e) => dispatch({ type: 'setName', name: e.target.value })}
          disabled={state === 'loading'}
          className={styles.input}
          autoComplete="name"
          aria-label="Your name"
          {...getLeadIntakeFieldErrorProps('name', invalidField, errorId)}
          name="name"
        />
        <input
          type="email"
          placeholder="Email address"
          value={email}
          onChange={(e) => dispatch({ type: 'setEmail', email: e.target.value })}
          disabled={state === 'loading'}
          className={styles.input}
          autoComplete="email"
          aria-label="Email address"
          {...getLeadIntakeFieldErrorProps('email', invalidField, errorId)}
          name="email"
        />
        <input
          type="text"
          placeholder="Business name"
          value={businessName}
          onChange={(e) => dispatch({ type: 'setBusinessName', businessName: e.target.value })}
          disabled={state === 'loading'}
          className={styles.input}
          autoComplete="organization"
          aria-label="Business name"
          {...getLeadIntakeFieldErrorProps('businessName', invalidField, errorId)}
          name="businessName"
        />
        <input
          type="text"
          placeholder="Google Maps link (optional - helps us prep)"
          value={googleMapsUrl}
          onChange={(e) => dispatch({ type: 'setGoogleMapsUrl', googleMapsUrl: e.target.value })}
          disabled={state === 'loading'}
          className={styles.input}
          autoComplete="url"
          aria-label="Google Maps link"
          name="googleMapsUrl"
        />

        {state === 'error' && errorMsg && (
          <p id={errorId} role="alert" className={styles.error}>{errorMsg}</p>
        )}

        <m.button
          type="submit"
          disabled={state === 'loading'}
          whileHover={{ scale: 1.05, y: -2, boxShadow: styles.hoverShadow }}
          whileTap={{ scale: 0.98 }}
          className={styles.button}
        >
          {state === 'loading' ? resolvedCopy.loading : resolvedCopy.button}
        </m.button>
      </form>
    </LazyMotion>
  );
}
