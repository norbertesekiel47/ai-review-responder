'use client';

import { useEffect, useRef, useState } from 'react';
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

// If signInWithOAuth resolves "successfully" but the browser never actually
// navigates (popup blocked, provider hiccup, ad-blocker), the button would stay
// stuck on "Redirecting…" forever. Re-enable it after this long with a nudge.
const NAVIGATION_FALLBACK_MS = 8000;

const START_FAILURE_MESSAGE =
  'Could not start Google sign-in. Please try again or use the email form below.';
const STILL_HERE_MESSAGE = 'Still here? Try again.';

export function useGoogleOAuth({ flow, next }: UseGoogleOAuthInput): UseGoogleOAuthReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearFallbackTimer() {
    if (fallbackTimer.current !== null) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
  }

  useEffect(() => clearFallbackTimer, []);

  async function start() {
    if (loading) return;
    setError('');
    setLoading(true);
    clearFallbackTimer();
    fallbackTimer.current = setTimeout(() => {
      // No navigation happened within the budget — let the owner retry.
      setLoading(false);
      setError(STILL_HERE_MESSAGE);
      fallbackTimer.current = null;
    }, NAVIGATION_FALLBACK_MS);
    try {
      const supabase = createBrowserSupabaseClient();
      const redirectTo = `${window.location.origin}/api/auth/callback?flow=${encodeURIComponent(flow)}&next=${encodeURIComponent(next)}`;
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      if (signInError) {
        clearFallbackTimer();
        setError(START_FAILURE_MESSAGE);
        setLoading(false);
      }
      // Success path: browser navigates away; do not clear loading to avoid
      // flicker. The fallback timer is the safety net if navigation never fires.
    } catch {
      clearFallbackTimer();
      setError(START_FAILURE_MESSAGE);
      setLoading(false);
    }
  }

  return { start, loading, error };
}
