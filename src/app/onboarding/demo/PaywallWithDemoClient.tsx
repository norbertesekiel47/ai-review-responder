'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

interface DemoPayload {
  id: string;
  generation_status: string;
  completed_at: string | null;
  source: string | null;
  reviews_snapshot: NormalizedReview[] | string | null;
  generated_responses: (GenerationResult | null)[] | string | null;
  business_name: string;
}

interface PaywallWithDemoClientProps {
  initialDemo: DemoPayload;
  isStale: boolean;
}

const MAX_POLLS = 15;

export function PaywallWithDemoClient({ initialDemo, isStale }: PaywallWithDemoClientProps) {
  const router = useRouter();
  const [demo] = useState<DemoPayload>(initialDemo);
  const [pollCount, setPollCount] = useState(0);

  // Postgres.js + PgBouncer can hand back JSONB columns as strings — guard
  // both shapes here rather than coupling the SSR layer to a specific driver.
  const reviews: NormalizedReview[] =
    typeof demo.reviews_snapshot === 'string'
      ? JSON.parse(demo.reviews_snapshot)
      : demo.reviews_snapshot ?? [];

  const responses: (GenerationResult | null)[] =
    typeof demo.generated_responses === 'string'
      ? JSON.parse(demo.generated_responses)
      : demo.generated_responses ?? [];

  const poll = useCallback(async () => {
    if (pollCount >= MAX_POLLS) return;
    try {
      const res = await fetch('/api/onboarding/demo/status');
      if (!res.ok) return;
      const body = await res.json();
      if (body.status !== demo.generation_status) {
        router.refresh();
      }
      setPollCount((c) => c + 1);
    } catch {
      // ignore
    }
  }, [pollCount, demo.generation_status, router]);

  useEffect(() => {
    if (demo.generation_status === 'queued' || demo.generation_status === 'running') {
      const interval = setInterval(poll, 2000);
      return () => clearInterval(interval);
    }
  }, [demo.generation_status, poll]);

  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        setPollCount(0);
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  async function handleRegenerate() {
    const res = await fetch('/api/onboarding/demo/regenerate', { method: 'POST' });
    if (res.ok) {
      router.refresh();
    }
  }

  const isLoading = demo.generation_status === 'queued' || demo.generation_status === 'running';
  const isFailed = demo.generation_status === 'failed';
  const isCompleted = demo.generation_status === 'completed';
  const isSkipped = demo.generation_status === 'skipped';
  const isFallback = demo.source === 'curated_fallback';

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold text-center mb-2">
          Your AI-powered review responses
        </h1>
        <p className="text-center text-gray-600 mb-8">
          Here&apos;s what RepWorth would write for {demo.business_name}
        </p>

        {isFallback && (
          <div className="bg-amber-50 border border-amber-200 rounded-md p-4 mb-6 text-sm text-amber-800">
            Sample reviews shown — connect your account after signup to see your real ones.
          </div>
        )}

        {isStale && isCompleted && demo.completed_at && (
          <div className="bg-gray-100 rounded-md p-3 mb-6 text-sm text-gray-600 text-center">
            Last updated {Math.floor((Date.now() - new Date(demo.completed_at).getTime()) / (24 * 60 * 60 * 1000))} days ago
          </div>
        )}

        {isLoading && (
          <div className="text-center py-12">
            <div className="inline-block w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-6" />
            <p className="text-gray-600">Generating your demo...</p>
            {pollCount >= MAX_POLLS && (
              <p className="text-sm text-gray-400 mt-2">
                Still working — refresh in a minute.
              </p>
            )}
          </div>
        )}

        {(isFailed || isSkipped) && (
          <div className="space-y-6">
            <div className="text-center py-8">
              {isFailed ? (
                <>
                  <div className="text-4xl mb-4" role="img" aria-label="warning">⚠️</div>
                  <p className="text-gray-600 mb-4">We couldn&apos;t generate a sample demo this time.</p>
                  <button
                    onClick={handleRegenerate}
                    className="bg-white border border-gray-300 text-gray-700 font-medium py-2 px-6 rounded-md hover:bg-gray-50 mb-2"
                  >
                    Try the demo again
                  </button>
                </>
              ) : (
                <p className="text-gray-600">
                  Your live demo is on the way after signup — for now, you can still subscribe.
                </p>
              )}
            </div>

            {/* Paywall stays available even when the demo isn't — never block payment on a transient generation issue. */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 sm:p-8 text-center">
              <h2 className="text-xl font-bold text-gray-900 mb-2">
                Choose your RepWorth plan
              </h2>
              <p className="text-gray-600 mb-6 max-w-md mx-auto">
                Subscribe to start automatically generating responses for every review.
              </p>
              <a
                href="/onboarding/pay"
                className="inline-block bg-blue-600 text-white font-medium px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors"
              >
                Choose a plan →
              </a>
            </div>
          </div>
        )}

        {isCompleted && (
          <div className="space-y-6">
            {reviews.map((review, index) => (
              <ReviewCard key={index} review={review} response={responses[index] ?? null} />
            ))}

            <div className="bg-white rounded-xl border border-gray-200 p-6 sm:p-8 text-center mt-8">
              <h2 className="text-xl font-bold text-gray-900 mb-2">
                Want this for every review?
              </h2>
              <p className="text-gray-600 mb-6 max-w-md mx-auto">
                Subscribe to RepWorth and we&apos;ll automatically generate responses for all your reviews.
              </p>
              <a
                href="/onboarding/pay"
                className="inline-block bg-blue-600 text-white font-medium px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors"
              >
                Choose a plan →
              </a>
            </div>

            <div className="text-center">
              <button
                onClick={handleRegenerate}
                className="text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Regenerate demo
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < rating ? 'text-yellow-400' : 'text-gray-300'}>
          ★
        </span>
      ))}
    </span>
  );
}

function ReviewCard({
  review,
  response,
}: {
  review: NormalizedReview;
  response: GenerationResult | null;
}) {
  const formattedDate = new Date(review.reviewDate).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between mb-2">
          <div>
            <span className="font-semibold text-gray-900">{review.reviewerName}</span>
            <span className="text-sm text-gray-400 ml-2">{formattedDate}</span>
          </div>
        </div>
        <Stars rating={review.starRating} />
        {review.reviewText ? (
          <p className="mt-2 text-gray-700 text-sm leading-relaxed">{review.reviewText}</p>
        ) : (
          <p className="mt-2 text-gray-400 text-sm italic">Rating only — no written review</p>
        )}
      </div>
      {response && (
        <div className="bg-blue-50 border-t border-blue-100 p-4 sm:p-5">
          <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider mb-2">AI Response</p>
          <p className="text-gray-700 text-sm leading-relaxed">{response.responseText}</p>
        </div>
      )}
    </div>
  );
}
