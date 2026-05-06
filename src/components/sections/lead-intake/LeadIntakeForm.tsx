'use client';

import type { FormEvent } from 'react';
import { useState } from 'react';
import { motion } from 'motion/react';

export type LeadIntent = 'waitlist' | 'demo';
export type LeadSource = 'landing' | 'book-a-demo' | 'pricing' | 'unknown';

type FormState = 'idle' | 'loading' | 'success' | 'error';
type InvalidLeadIntakeField = 'name' | 'email' | 'businessName';
type LeadIntakeField = InvalidLeadIntakeField | 'googleMapsUrl';

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export function submitLeadIntake(payload: LeadIntakePayload): Promise<Response> {
  return fetch('/api/lead-intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function validateLeadIntakeFields({
  name,
  email,
  businessName,
}: Pick<LeadIntakePayload, 'name' | 'email' | 'businessName'>): LeadIntakeValidationResult {
  if (!name.trim()) {
    return { message: 'Please enter your name.', invalidField: 'name' };
  }

  if (!EMAIL_RE.test(email.trim())) {
    return {
      message: 'Please enter a valid email address.',
      invalidField: 'email',
    };
  }

  if (!businessName.trim()) {
    return {
      message: 'Please enter your business name.',
      invalidField: 'businessName',
    };
  }

  return null;
}

export function getLeadIntakeFieldErrorProps(
  field: LeadIntakeField,
  invalidField: InvalidLeadIntakeField | null,
  errorId: string,
) {
  if (field !== invalidField) return {};

  return {
    'aria-invalid': true,
    'aria-describedby': errorId,
  };
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

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [state, setState] = useState<FormState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [invalidField, setInvalidField] = useState<InvalidLeadIntakeField | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const validationError = validateLeadIntakeFields({
      name,
      email,
      businessName,
    });
    if (validationError) {
      setErrorMsg(validationError.message);
      setInvalidField(validationError.invalidField);
      setState('error');
      return;
    }

    setState('loading');
    setErrorMsg('');
    setInvalidField(null);

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
        setState('success');
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMsg((data as { error?: string }).error ?? 'Something went wrong. Please try again.');
        setInvalidField(null);
        setState('error');
      }
    } catch {
      setErrorMsg('Network error. Please check your connection and try again.');
      setInvalidField(null);
      setState('error');
    }
  };

  if (state === 'success') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className={styles.success}
      >
        <h3 className={styles.successHeading}>{resolvedCopy.successHeading}</h3>
        <p className={styles.successBody}>{resolvedCopy.successBody}</p>
      </motion.div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className={styles.form}>
      <input type="hidden" name="intent" value={intent} readOnly />
      <input type="hidden" name="source" value={source} readOnly />
      <input
        type="text"
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
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
        onChange={(e) => setEmail(e.target.value)}
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
        onChange={(e) => setBusinessName(e.target.value)}
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
        onChange={(e) => setGoogleMapsUrl(e.target.value)}
        disabled={state === 'loading'}
        className={styles.input}
        autoComplete="url"
        aria-label="Google Maps link"
        name="googleMapsUrl"
      />

      {state === 'error' && errorMsg && (
        <p id={errorId} role="alert" className={styles.error}>{errorMsg}</p>
      )}

      <motion.button
        type="submit"
        disabled={state === 'loading'}
        whileHover={{ scale: 1.05, y: -2, boxShadow: styles.hoverShadow }}
        whileTap={{ scale: 0.98 }}
        className={styles.button}
      >
        {state === 'loading' ? resolvedCopy.loading : resolvedCopy.button}
      </motion.button>
    </form>
  );
}
