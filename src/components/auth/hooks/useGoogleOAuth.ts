'use client';

import { useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import type { AuthFlow } from '@/lib/shared/auth-flow';

export interface UseGoogleOAuthInput {
  flow: AuthFlow;
  next: string;
}

export interface UseGoogleOAuthReturn {
  start: () => Promise<void>;
  loading: boolean;
  error: string;
}

export function useGoogleOAuth({ flow, next }: UseGoogleOAuthInput): UseGoogleOAuthReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const redirectTo = `${window.location.origin}/api/auth/callback?flow=${encodeURIComponent(flow)}&next=${encodeURIComponent(next)}`;
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      if (signInError) {
        setError(
          'Could not start Google sign-in. Please try again or use the email form below.',
        );
        setLoading(false);
      }
      // Success path: browser navigates away; do not clear loading to avoid flicker.
    } catch {
      setError(
        'Could not start Google sign-in. Please try again or use the email form below.',
      );
      setLoading(false);
    }
  }

  return { start, loading, error };
}
