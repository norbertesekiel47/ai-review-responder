'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import type { AuthFlow } from '@/lib/shared/auth-flow';
import {
  isEmailNotConfirmedError,
  mapSupabaseAuthError,
} from '@/components/auth/shared/mapLoginError';
import {
  applySubscriptionGuard,
  resolvePostLoginDestination,
  type SignupStatusPayload,
} from '@/components/auth/shared/loginDestination';
import { mfaChallengePath, requireAal2FromSupabase } from '@/lib/auth/mfa';

export interface UseLoginSubmitInput {
  portal: AuthFlow;
  allowedRoles: readonly string[];
  defaultRoute: string;
}

export interface UseLoginSubmitReturn {
  submit: (email: string, password: string, from: string) => Promise<void>;
  loading: boolean;
  error: string;
  setError: (e: string) => void;
}

export function useLoginSubmit({
  portal,
  allowedRoles,
  defaultRoute,
}: UseLoginSubmitInput): UseLoginSubmitReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  // Pre-existing multi-step login flow (auth → users lookup → signup-status →
  // MFA): sequential awaits with guard branches, not tangled logic.
  // fallow-ignore-next-line complexity
  async function submit(rawEmail: string, password: string, from: string) {
    const email = rawEmail.trim().toLowerCase();
    setError('');
    setLoading(true);
    try {
      const attemptLimit = await fetch('/api/auth/login-attempt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (attemptLimit.status === 429) {
        setError('Too many sign-in attempts. Try again in a few minutes.');
        return;
      }
      if (!attemptLimit.ok) {
        setError('Sign-in is temporarily unavailable. Please try again.');
        return;
      }

      const supabase = createBrowserSupabaseClient();
      const { error: authError, data } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        if (isEmailNotConfirmedError(authError.message)) {
          // The check-email page (CheckEmailClient) reads the email from the
          // ?email= query param to POST verify/resend, so it must travel in the
          // URL here. Routing it via sessionStorage would require teaching that
          // page to read PREFILL_EMAIL_KEY first — out of scope for this island.
          router.push(`/signup/check-email?from=login&email=${encodeURIComponent(email)}`);
          return;
        }
        setError(mapSupabaseAuthError(authError.message));
        return;
      }

      const authId = data?.user?.id;
      if (!authId) {
        await supabase.auth.signOut();
        setError('Sign-in succeeded but no auth user was returned. Please try again.');
        return;
      }

      const { data: userRow, error: lookupErr } = await supabase
        .from('users')
        .select('role')
        .eq('auth_id', authId)
        .limit(1)
        .maybeSingle();

      if (lookupErr) {
        await supabase.auth.signOut();
        setError('Could not load your account details. Please try again.');
        return;
      }
      if (!userRow) {
        await supabase.auth.signOut();
        setError('Your account is not fully set up. Contact your administrator.');
        return;
      }

      const role = (userRow as { role: string }).role;
      if (!allowedRoles.includes(role)) {
        await supabase.auth.signOut();
        setError(
          portal === 'owner'
            ? 'That account is for the admin portal. Use /admin/login instead.'
            : 'That account is for the owner portal. Use /login instead.',
        );
        return;
      }

      let destinationOverride: string | null = null;
      if (portal === 'owner') {
        try {
          const statusRes = await fetch('/api/auth/signup-status');
          if (statusRes.ok) {
            const status = (await statusRes.json()) as SignupStatusPayload;
            destinationOverride = applySubscriptionGuard(portal, status, from);
          }
        } catch {
          // Soft-fail; downstream guards will catch this on next nav.
        }
      }

      const destination =
        destinationOverride ??
        resolvePostLoginDestination(portal, from, defaultRoute);

      const aal = await requireAal2FromSupabase(supabase);
      if (!aal.ok && aal.reason === 'mfa_required') {
        router.push(mfaChallengePath(destination));
        return;
      }
      if (!aal.ok && aal.reason === 'mfa_check_failed') {
        setError('Could not verify your authentication level. Please try again.');
        return;
      }

      router.push(destination);
      router.refresh();
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  return { submit, loading, error, setError };
}
