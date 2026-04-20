'use client';

import { useState } from 'react';
import { motion } from 'motion/react';

type FormState = 'idle' | 'loading' | 'success' | 'error';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function BookDemoForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [state, setState] = useState<FormState>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const validate = (): string | null => {
    if (!name.trim()) return 'Please enter your name.';
    if (!EMAIL_RE.test(email.trim())) return 'Please enter a valid email address.';
    if (!businessName.trim()) return 'Please enter your business name.';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setErrorMsg(validationError);
      setState('error');
      return;
    }

    setState('loading');
    setErrorMsg('');

    try {
      const res = await fetch('/api/demo-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          businessName: businessName.trim(),
          googleMapsUrl: googleMapsUrl.trim(),
        }),
      });

      if (res.ok) {
        setState('success');
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMsg((data as { error?: string }).error ?? 'Something went wrong. Please try again.');
        setState('error');
      }
    } catch {
      setErrorMsg('Network error. Please check your connection and try again.');
      setState('error');
    }
  };

  if (state === 'success') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl bg-white border border-[#97B3AE]/20 shadow-lg p-8 text-center"
      >
        <div className="text-4xl mb-4">🎉</div>
        <h3 className="text-2xl text-[#2a2a2a] font-medium mb-2">You&apos;re booked!</h3>
        <p className="text-[#6a6a6a]">We&apos;ll reach out within a few hours to confirm your demo time.</p>
      </motion.div>
    );
  }

  const inputClass =
    'w-full rounded-lg bg-[#F0EEEA]/50 border border-[#97B3AE]/20 px-4 py-3 text-[#2a2a2a] placeholder-[#6a6a6a]/60 focus:outline-none focus:ring-2 focus:ring-[#97B3AE]/40 transition-all text-sm';

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <input
        type="text"
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="name"
        aria-label="Your name"
        name="name"
      />
      <input
        type="email"
        placeholder="Email address"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="email"
        aria-label="Email address"
        name="email"
      />
      <input
        type="text"
        placeholder="Business name"
        value={businessName}
        onChange={(e) => setBusinessName(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="organization"
        aria-label="Business name"
        name="organization"
      />
      <input
        type="text"
        placeholder="Google Maps link (optional — helps us prep your demo)"
        value={googleMapsUrl}
        onChange={(e) => setGoogleMapsUrl(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="url"
        aria-label="Google Maps link"
        name="url"
      />

      {state === 'error' && errorMsg && (
        <p className="text-sm text-red-500">{errorMsg}</p>
      )}

      <motion.button
        type="submit"
        disabled={state === 'loading'}
        whileHover={{ scale: 1.05, y: -2, boxShadow: '0 20px 40px rgba(151,179,174,0.3)' }}
        whileTap={{ scale: 0.98 }}
        className="w-full px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-opacity"
      >
        {state === 'loading' ? 'Sending…' : 'Book My Demo'}
      </motion.button>
    </form>
  );
}
