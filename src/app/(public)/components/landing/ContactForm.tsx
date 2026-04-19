'use client';

import { useState } from 'react';
import { motion } from 'motion/react';

type FormState = 'idle' | 'loading' | 'success' | 'error';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
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
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), businessName: businessName.trim() }),
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
        className="rounded-2xl bg-white/10 border border-white/30 p-8 text-center"
      >
        <div className="text-4xl mb-4">🎉</div>
        <h3 className="text-2xl text-white mb-2">Request received!</h3>
        <p className="text-white/80">We&apos;ll be in touch within 24 hours.</p>
      </motion.div>
    );
  }

  const inputClass =
    'w-full rounded-lg bg-white/20 border border-white/30 px-4 py-3 text-white placeholder-white/60 focus:outline-none focus:ring-2 focus:ring-white/40 transition-all';

  return (
    <form onSubmit={handleSubmit} noValidate className="max-w-md mx-auto space-y-4">
      <input
        type="text"
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="name"
      />
      <input
        type="email"
        placeholder="Email address"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="email"
      />
      <input
        type="text"
        placeholder="Business name"
        value={businessName}
        onChange={(e) => setBusinessName(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="organization"
      />

      {state === 'error' && errorMsg && (
        <p className="text-sm text-red-200">{errorMsg}</p>
      )}

      <motion.button
        type="submit"
        disabled={state === 'loading'}
        whileHover={{ scale: 1.05, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}
        whileTap={{ scale: 0.98 }}
        className="w-full px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-opacity"
      >
        {state === 'loading' ? 'Sending…' : 'Book a Demo'}
      </motion.button>
    </form>
  );
}
