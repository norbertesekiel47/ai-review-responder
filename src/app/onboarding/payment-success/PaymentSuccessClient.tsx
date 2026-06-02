'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { LazyMotion, m, domAnimation } from 'motion/react';
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';
import { primaryButtonClass, buttonMotion } from '../_shared/field-styles';

// Fixed-interval poll cadence. The original loop used 2s→×1.5→30s backoff with a
// 5-minute wall-clock cap, which made ~18 actual fetches before giving up (the
// growing delays, not a fixed 2s, are what stretched 18 attempts across 5min).
// The react-query mapping keeps the same envelope — poll until success or a
// bounded stop — with a simpler fixed 2s interval and an attempt cap chosen to
// match the original's effective fetch count.
const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 20;

// Sentinel thrown while Stripe is still provisioning (subscription not yet
// 'active', or a transient 404/429/5xx). react-query treats it as retryable and
// keeps polling; it carries no diagnostic value of its own.
class SubscriptionNotReadyError extends Error {}

// Terminal auth failure (401/403): the session is gone (expired during the
// Stripe round-trip, or revoked elsewhere). Polling forever here is a dead end —
// this is thrown as a NON-retryable error and drives a redirect to login via a
// state-keyed effect, keeping navigation out of the data-fetching path. Both 401
// and 403 map here even though the API currently only emits 401 — defensive
// against future routes that add proper RBAC failures.
class SessionExpiredError extends Error {}

type SignupStatus = {
  subscriptionStatus: string;
  businessOnboarded: boolean;
};

export function PaymentSuccessClient({
  checkoutSessionId,
}: {
  checkoutSessionId?: string | null;
}) {
  const router = useRouter();

  const { data, isError, error, failureCount } = useQuery<
    SignupStatus,
    SessionExpiredError | SubscriptionNotReadyError | Error
  >({
    queryKey: ['onboarding-signup-status', checkoutSessionId],
    enabled: Boolean(checkoutSessionId),
    queryFn: async (): Promise<SignupStatus> => {
      const statusUrl = checkoutSessionId
        ? `/api/auth/signup-status?session_id=${encodeURIComponent(checkoutSessionId)}`
        : '/api/auth/signup-status';
      const res = await fetch(statusUrl);

      if (res.status === 401 || res.status === 403) {
        throw new SessionExpiredError();
      }

      if (res.ok) {
        const body = (await res.json()) as SignupStatus;
        if (body.subscriptionStatus === 'active') {
          return body;
        }
      }
      // Anything else (404 mid-provisioning, 429 rate-limit, 5xx, or a non-active
      // status) is retryable — keep polling.
      throw new SubscriptionNotReadyError();
    },
    // SessionExpiredError is terminal (never retry → redirect immediately).
    // SubscriptionNotReadyError retries up to the attempt cap. react-query
    // evaluates this with the PRE-increment failureCount right after the
    // (failureCount + 1)-th fetch fails, so `< MAX_ATTEMPTS - 1` caps total
    // fetches at MAX_ATTEMPTS.
    retry: (currentFailureCount, err) =>
      err instanceof SubscriptionNotReadyError && currentFailureCount < MAX_ATTEMPTS - 1,
    retryDelay: POLL_INTERVAL_MS,
    gcTime: 0,
  });

  const sessionExpired = isError && error instanceof SessionExpiredError;
  // Exhausted the retry budget without confirmation → the "Still processing…"
  // copy. A non-SessionExpired error reaching isError means retry stopped, which
  // only happens at the attempt cap (transport errors are wrapped as retryable
  // SubscriptionNotReadyError, never surfaced before the cap).
  const timedOut = isError && !sessionExpired && failureCount >= MAX_ATTEMPTS - 1;

  const active = Boolean(data);
  const needsSetup = active && data ? !data.businessOnboarded : false;

  // Terminal 401/403 → route to login so they can re-authenticate. Driven off
  // the error state (not the fetch callback) so navigation is not buried inside
  // data-fetching logic; if the component unmounts first, the effect never runs.
  useEffect(() => {
    if (!sessionExpired) return;
    router.push('/login?error=session_expired&from=/onboarding/payment-success');
  }, [sessionExpired, router]);

  return (
    <LazyMotion features={domAnimation}>
    <OnboardingFunnelShell step="setup">
      <div className="max-w-md mx-auto text-center py-6">
        {active ? (
          <>
            <m.div
              className="size-16 mx-auto mb-6 rounded-full bg-[#97B3AE] flex items-center justify-center shadow-lg"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.5, ease: 'easeOut', delay: 0.1 }}
            >
              <svg
                className="size-8 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.5}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </m.div>
            {needsSetup ? (
              <>
                <h1 className="text-3xl font-medium text-[#2a2a2a] mb-3">
                  You&apos;re in. Payment confirmed
                </h1>
                <p className="text-[#6a6a6a] mb-8">
                  Let&apos;s finish setting up your business.
                </p>
                <m.button
                  onClick={() => router.push('/onboarding/business')}
                  {...buttonMotion}
                  className={primaryButtonClass}
                >
                  Continue setup →
                </m.button>
              </>
            ) : (
              <>
                <h1 className="text-3xl font-medium text-[#2a2a2a] mb-3">
                  Welcome to RepWorth!
                </h1>
                <p className="text-[#6a6a6a] mb-8">Your subscription is active.</p>
                <m.button
                  onClick={() => router.push('/dashboard')}
                  {...buttonMotion}
                  className={primaryButtonClass}
                >
                  Go to dashboard
                </m.button>
              </>
            )}
          </>
        ) : timedOut ? (
          <>
            <h1 className="text-2xl font-medium text-[#2a2a2a] mb-3">
              Still processing…
            </h1>
            <p className="text-[#6a6a6a]">
              This is taking longer than usual. Please{' '}
              <a href="mailto:support@repworth.net" className="text-[#97B3AE] underline">
                contact support
              </a>{' '}
              if it persists.
            </p>
          </>
        ) : (
          <>
            <div className="inline-block size-12 border-4 border-[#97B3AE]/25 border-t-[#97B3AE] rounded-full animate-spin mb-6" />
            <h1 className="text-2xl font-medium text-[#2a2a2a] mb-3">
              Processing your payment…
            </h1>
            <p className="text-[#6a6a6a]">This usually takes a few seconds.</p>
          </>
        )}
      </div>
    </OnboardingFunnelShell>
    </LazyMotion>
  );
}
