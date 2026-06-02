'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';

function PaymentSuccessContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionId = searchParams.get('session_id');

  useEffect(() => {
    if (!sessionId) {
      setStatus('error');
      setError('No session ID found in URL');
      return;
    }

    // Poll the business table — the Stripe webhook may take a few seconds to
    // process and transition the status to 'active'. Timers are tracked so the
    // cleanup below can cancel them if the admin navigates away mid-poll.
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let redirectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const maxAttempts = 15;

    async function checkBusiness() {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/admin/payment-success?session_id=${sessionId}`);
        const json = await res.json();
        if (cancelled) return;

        if (res.ok && json.businessId) {
          setBusinessId(json.businessId);
          setStatus('success');
          // Auto-redirect after 3 seconds
          redirectTimer = setTimeout(() => {
            if (cancelled) return;
            router.push(`/admin/businesses/${json.businessId}`);
          }, 3000);
          return;
        }

        attempts++;
        if (attempts < maxAttempts) {
          pollTimer = setTimeout(checkBusiness, 2000);
        } else {
          setStatus('error');
          setError('Could not find the business. The payment may still be processing — check the admin overview.');
        }
      } catch {
        if (cancelled) return;
        setStatus('error');
        setError('Network error — check the admin overview for your business.');
      }
    }

    void checkBusiness();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (redirectTimer) clearTimeout(redirectTimer);
    };
  }, [sessionId, router]);

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
          <p className="mt-2 text-sm text-gray-500">{error}</p>
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

export default function PaymentSuccessPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <Suspense
        fallback={
          <div className="max-w-md w-full rounded-lg bg-white p-8 text-center shadow-sm">
            <div className="mx-auto mb-4 size-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
            <h1 className="text-lg font-semibold text-gray-900">Loading…</h1>
          </div>
        }
      >
        <PaymentSuccessContent />
      </Suspense>
    </div>
  );
}
