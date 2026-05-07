'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { mapSignupError, type MappedSignupError } from '@/components/auth/shared/mapSignupError';
import { safeSignupRedirect } from '@/components/auth/shared/safeSignupRedirect';

export interface UseSignupSubmitReturn {
  submit: (input: SignupInput) => Promise<{ ok: boolean }>;
  loading: boolean;
  error: string;
  errorKind: MappedSignupError['kind'] | null;
  setError: (e: string) => void;
}

export interface SignupInput {
  ownerEmail: string;
  ownerName: string;
  ownerPhone: string; // empty string ok; will be omitted from payload
  password: string;
}

export function useSignupSubmit(): UseSignupSubmitReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState<MappedSignupError['kind'] | null>(null);
  const router = useRouter();

  async function submit(input: SignupInput) {
    setError('');
    setErrorKind(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: input.ownerEmail.trim().toLowerCase(),
          ownerName: input.ownerName.trim(),
          ownerPhone: input.ownerPhone.trim() || undefined,
          password: input.password,
        }),
      });
      const body = (await res.json()) as { error?: unknown; message?: unknown; redirectTo?: unknown };
      if (!res.ok) {
        const mapped = mapSignupError(body, res.status);
        setError(mapped.message);
        setErrorKind(mapped.kind);
        return { ok: false };
      }
      router.push(safeSignupRedirect(body.redirectTo));
      return { ok: true };
    } catch {
      setError('Connection failed');
      setErrorKind('unknown');
      return { ok: false };
    } finally {
      setLoading(false);
    }
  }

  return { submit, loading, error, errorKind, setError };
}
