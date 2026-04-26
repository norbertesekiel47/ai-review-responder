'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export function PaymentSuccessClient() {
  const [active, setActive] = useState(false);
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
        const res = await fetch('/api/auth/signup-status', {
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
          if (body.subscriptionStatus === 'active') {
            // The wizard at /onboarding/business is the next required step
            // for self-serve owners. Push them straight in — no extra
            // "Welcome!" button — so they don't have a chance to bookmark
            // a half-onboarded dashboard.
            if (!body.businessOnboarded) {
              router.push('/onboarding/business');
              return;
            }
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
      if (now - startedAt > 5 * 60_000) return; // 5-min cap
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
  }, [router]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 p-8 text-center">
        {active ? (
          <>
            <h1 className="text-2xl font-bold mb-4">Welcome to RepWorth!</h1>
            <p className="text-gray-700 mb-6">Your subscription is active.</p>
            <button
              onClick={() => router.push('/dashboard')}
              className="bg-blue-600 text-white font-medium py-3 px-8 rounded-md hover:bg-blue-700"
            >
              Go to dashboard
            </button>
          </>
        ) : elapsed > 5 * 60_000 ? (
          <>
            <h1 className="text-xl font-bold mb-4">Still processing...</h1>
            <p className="text-gray-700">
              This is taking longer than usual. Please contact support if it
              persists.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold mb-4">
              Processing your payment...
            </h1>
            <p className="text-gray-600">This usually takes a few seconds.</p>
          </>
        )}
      </div>
    </div>
  );
}
