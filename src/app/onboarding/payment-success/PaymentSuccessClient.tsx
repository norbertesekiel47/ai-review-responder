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
    let delay = 2000;
    const startedAt = Date.now();

    async function poll() {
      if (cancelled) return;
      try {
        const res = await fetch('/api/auth/signup-status');
        if (cancelled) return;
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
      } catch {
        // transient network error — retry on next tick
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
    };
  }, []);

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
