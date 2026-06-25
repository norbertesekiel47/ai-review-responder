'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LazyMotion, m, domAnimation } from 'motion/react';
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';
import { primaryButtonClass, buttonMotion } from '../_shared/field-styles';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';

// Single source of truth for the polling cap. Used by both the poll loop
// (to stop scheduling new ticks) and the UI branch that switches to the
// "Still processing…" copy. Keeping these synced prevents drift where the
// loop stops at 5min but the UI keeps showing the spinner indefinitely
// (or vice versa).
const MAX_POLL_DURATION_MS = 5 * 60_000;

export function PaymentSuccessClient({
  checkoutSessionId,
}: {
  checkoutSessionId?: string | null;
}) {
  const [active, setActive] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    // Track the in-flight AbortController so the cleanup function can also
    // abort a pending fetch — without this, a stuck request (e.g., Vercel
    // cold-start hang) would keep awaiting after the user navigates away.
    let activeController: AbortController | null = null;
    let delay = 2000;
    const startedAt = Date.now();

    // Per-request timeout. The poll interval grows from 2s up to 30s, so
    // a fetch that takes >10s is almost certainly stuck — abort and let
    // the retry/backoff loop drive the recovery instead of awaiting forever.
    const FETCH_TIMEOUT_MS = 10_000;

    async function poll() {
      if (cancelled) return;
      const controller = new AbortController();
      activeController = controller;
      const abortTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const statusUrl = checkoutSessionId
          ? `/api/auth/signup-status?session_id=${encodeURIComponent(checkoutSessionId)}`
          : '/api/auth/signup-status';
        const res = await fetch(statusUrl, {
          signal: controller.signal,
        });
        if (cancelled) return;

        // Terminal auth failures — the session is gone (expired during the
        // Stripe round-trip, or revoked elsewhere). Polling forever in
        // this state is a dead end; route them to login so they can
        // re-authenticate. Both 401 and 403 land here even though the
        // current API only emits 401 — defensive against future route
        // changes that add proper RBAC failures.
        if (res.status === 401 || res.status === 403) {
          // Don't continue the loop. The unmount on router.push() will fire
          // the cleanup function below and clear any timers, but mark
          // cancelled here too so a synchronous retry can't slip through.
          cancelled = true;
          router.push('/login?error=session_expired&from=/onboarding/payment-success');
          return;
        }

        if (res.ok) {
          const body = (await res.json()) as {
            subscriptionStatus: string;
            businessOnboarded: boolean;
          };
          if (subscriptionGrantsFullAccess(body.subscriptionStatus)) {
            // Checkout confirmed (paid OR trial started — a $0 trial completes
            // checkout the same way). Acknowledge it on THIS page before the
            // user moves on. Not-yet-onboarded owners get an explicit "Continue
            // setup" CTA into the wizard (NOT the dashboard) — this gives the
            // acknowledgement while preserving the original intent of never
            // landing them on a half-onboarded dashboard they could bookmark.
            setNeedsSetup(!body.businessOnboarded);
            setActive(true);
            return;
          }
        }
        // Anything else (404 mid-provisioning, 429 rate-limit, 5xx) falls
        // through to the retry/backoff path below.
      } catch (err) {
        if (cancelled) return;
        // AbortError fires both when the per-request timeout trips AND when
        // cleanup aborts on unmount. The cancelled check above handles the
        // unmount case; the timeout case falls through to retry naturally.
        if (err instanceof DOMException && err.name === 'AbortError') {
          // fall through to retry
        }
        // Other transient errors (network down, JSON parse fail) — retry.
      } finally {
        clearTimeout(abortTimer);
        if (activeController === controller) activeController = null;
      }

      if (cancelled) return;
      const now = Date.now();
      setElapsed(now - startedAt);
      if (now - startedAt > MAX_POLL_DURATION_MS) return;
      delay = Math.min(delay * 1.5, 30_000);
      timerId = setTimeout(poll, delay);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
      // Abort any in-flight fetch so the await unblocks immediately and
      // the .finally() runs to clear the per-request timeout. Without
      // this, a hung request continues consuming until its 10s timeout
      // even though the component is gone.
      if (activeController) activeController.abort();
    };
  }, [router, checkoutSessionId]);

  return (
    <LazyMotion features={domAnimation}>
    <OnboardingFunnelShell step="setup">
      <div className="max-w-md mx-auto text-center py-6">
        {active ? (
          <>
            <m.div
              className="size-16 mx-auto mb-6 rounded-full bg-rw-teal flex items-center justify-center shadow-lg"
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
                <h1 className="text-3xl font-medium text-rw-ink mb-3">
                  You&apos;re in. Payment confirmed
                </h1>
                <p className="text-rw-ink-soft mb-8">
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
                <h1 className="text-3xl font-medium text-rw-ink mb-3">
                  Welcome to RepWorth!
                </h1>
                <p className="text-rw-ink-soft mb-8">Your subscription is active.</p>
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
        ) : elapsed > MAX_POLL_DURATION_MS ? (
          <>
            <h1 className="text-2xl font-medium text-rw-ink mb-3">
              Still processing…
            </h1>
            <p className="text-rw-ink-soft">
              This is taking longer than usual. Please{' '}
              <a href="mailto:support@repworth.net" className="text-rw-teal underline">
                contact support
              </a>{' '}
              if it persists.
            </p>
          </>
        ) : (
          <>
            <div className="inline-block size-12 border-4 border-rw-teal/25 border-t-rw-teal rounded-full animate-spin mb-6" />
            <h1 className="text-2xl font-medium text-rw-ink mb-3">
              Processing your payment…
            </h1>
            <p className="text-rw-ink-soft">This usually takes a few seconds.</p>
          </>
        )}
      </div>
    </OnboardingFunnelShell>
    </LazyMotion>
  );
}
