'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 15;
const REDIRECT_DELAY_MS = 3000;

// Sentinel thrown by the query fn while the Stripe webhook is still
// provisioning the business. It carries no diagnostic value of its own —
// react-query treats it as a retryable failure and keeps polling — so it is
// deliberately distinct from a real transport error (which surfaces as the
// "Network error" message below).
class BusinessNotReadyError extends Error {}

export function PaymentSuccessContent({ sessionId }: { sessionId: string | null }) {
  const router = useRouter();

  const {
    data: businessId,
    isError,
    error,
  } = useQuery({
    queryKey: ['admin-payment-success', sessionId],
    enabled: Boolean(sessionId),
    // Poll the business table — the Stripe webhook may take a few seconds to
    // process and transition the status to 'active'. The query fn throws a
    // BusinessNotReadyError until the row is found, which lets react-query's
    // retry machinery drive the poll cadence.
    queryFn: async (): Promise<string> => {
      const res = await fetch(`/api/admin/payment-success?session_id=${sessionId}`);
      const json = await res.json();
      if (res.ok && json.businessId) {
        return json.businessId as string;
      }
      throw new BusinessNotReadyError();
    },
    // Treat "not ready yet" as retryable so that exactly MAX_ATTEMPTS total
    // fetches run before giving up. react-query evaluates this predicate with
    // the PRE-increment failureCount right after the (failureCount + 1)-th
    // fetch fails, so `< MAX_ATTEMPTS - 1` stops the 16th fetch from the 15th
    // failure (preserving the original `attempts < 15` cap of 15 fetches). A
    // genuine transport/parse error (anything that is NOT BusinessNotReady)
    // fails immediately, matching the original try/catch that routed network
    // errors straight to the error state.
    retry: (currentFailureCount, err) =>
      err instanceof BusinessNotReadyError && currentFailureCount < MAX_ATTEMPTS - 1,
    retryDelay: POLL_INTERVAL_MS,
    gcTime: 0,
  });

  const status: 'loading' | 'success' | 'error' = !sessionId
    ? 'error'
    : businessId
      ? 'success'
      : isError
        ? 'error'
        : 'loading';

  const errorMessage = !sessionId
    ? 'No session ID found in URL'
    : error instanceof BusinessNotReadyError
      ? 'Could not find the business. The payment may still be processing — check the admin overview.'
      : 'Network error — check the admin overview for your business.';

  // Auto-redirect after 3 seconds once the business is confirmed. Driven off
  // the rendered success state (not the fetch callback) so the navigation is
  // not buried inside data-fetching logic; the cleanup cancels the pending
  // redirect if the admin navigates away first.
  useEffect(() => {
    if (status !== 'success' || !businessId) return;
    const redirectTimer = setTimeout(() => {
      router.push(`/admin/businesses/${businessId}`);
    }, REDIRECT_DELAY_MS);
    return () => clearTimeout(redirectTimer);
  }, [status, businessId, router]);

  return (
    <div className="max-w-md w-full rounded-lg bg-white p-8 text-center shadow-sm">
      {status === 'loading' && (
        <>
          <div className="mx-auto mb-4 size-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
          <h1 className="text-lg font-semibold text-gray-900">Processing payment…</h1>
          <p className="mt-2 text-sm text-gray-500">Waiting for Stripe confirmation. This usually takes a few seconds.</p>
        </>
      )}

      {status === 'success' && businessId && (
        <>
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-green-100">
            <svg className="size-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-gray-900">Payment confirmed!</h1>
          <p className="mt-2 text-sm text-gray-500">Subscription is now active. Redirecting to business page…</p>
          <Link
            href={`/admin/businesses/${businessId}`}
            className="mt-4 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Go to Business
          </Link>
        </>
      )}

      {status === 'error' && (
        <>
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-yellow-100">
            <svg className="size-6 text-yellow-600" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-gray-900">Payment received</h1>
          <p className="mt-2 text-sm text-gray-500">{errorMessage}</p>
          <Link
            href="/admin/overview"
            className="mt-4 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Go to Admin Overview
          </Link>
        </>
      )}
    </div>
  );
}
