'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';

export default function PaymentSuccessPage() {
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

    // Poll the business table — the Stripe webhook may take a few seconds
    // to process and transition the status to 'active'
    let attempts = 0;
    const maxAttempts = 15;

    async function checkBusiness() {
      try {
        const res = await fetch(`/api/admin/payment-success?session_id=${sessionId}`);
        const json = await res.json();

        if (res.ok && json.businessId) {
          setBusinessId(json.businessId);
          setStatus('success');
          // Auto-redirect after 3 seconds
          setTimeout(() => {
            router.push(`/admin/businesses/${json.businessId}`);
          }, 3000);
          return;
        }

        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(checkBusiness, 2000);
        } else {
          setStatus('error');
          setError('Could not find the business. The payment may still be processing — check the admin overview.');
        }
      } catch {
        setStatus('error');
        setError('Network error — check the admin overview for your business.');
      }
    }

    checkBusiness();
  }, [sessionId, router]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full rounded-lg bg-white p-8 text-center shadow-sm">
        {status === 'loading' && (
          <>
            <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-amber-600 border-t-transparent" />
            <h1 className="text-lg font-semibold text-gray-900">Processing payment...</h1>
            <p className="mt-2 text-sm text-gray-500">Waiting for Stripe confirmation. This usually takes a few seconds.</p>
          </>
        )}

        {status === 'success' && businessId && (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold text-gray-900">Payment confirmed!</h1>
            <p className="mt-2 text-sm text-gray-500">Subscription is now active. Redirecting to business page...</p>
            <Link
              href={`/admin/businesses/${businessId}`}
              className="mt-4 inline-block rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
            >
              Go to Business
            </Link>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-yellow-100">
              <svg className="h-6 w-6 text-yellow-600" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold text-gray-900">Payment received</h1>
            <p className="mt-2 text-sm text-gray-500">{error}</p>
            <Link
              href="/admin/overview"
              className="mt-4 inline-block rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
            >
              Go to Admin Overview
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
