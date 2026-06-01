'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';
import { motion } from 'motion/react';
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';
import { infoBannerClass, primaryButtonClass, buttonMotion } from '../_shared/field-styles';

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
  // Read directly from props — do NOT useState(initialDemo). useState only
  // captures the initial value once; when polling triggers router.refresh()
  // the server passes a NEW initialDemo (e.g. status flipped to 'completed'),
  // but useState would return the stale 'queued' snapshot forever and the
  // loading spinner would never clear. SSR is the source of truth here.
  const demo = initialDemo;
  const [pollCount, setPollCount] = useState(0);
  const [nowMs, setNowMs] = useState<number | null>(null);

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
    if (demo.completed_at) setNowMs(Date.now());
  }, [demo.completed_at]);

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
  const staleAgeDays =
    nowMs !== null && demo.completed_at
      ? Math.floor((nowMs - new Date(demo.completed_at).getTime()) / (24 * 60 * 60 * 1000))
      : null;

  return (
    <OnboardingFunnelShell step="preview">
      <h1 className="text-3xl md:text-4xl font-medium text-center text-[#2a2a2a] mb-2">
        Your AI-powered review responses
      </h1>
      <p className="text-center text-[#6a6a6a] mb-8">
        Here&apos;s what RepWorth would write for {demo.business_name}
      </p>

      {isFallback && (
        <div className={`${infoBannerClass} mb-6`}>
          Sample reviews shown — connect your account after signup to see your
          real ones.
        </div>
      )}

      {isStale && isCompleted && staleAgeDays !== null && (
        <div className="bg-[#F0EEEA] rounded-xl p-3 mb-6 text-sm text-[#6a6a6a] text-center">
          Last updated {staleAgeDays} days ago
        </div>
      )}

      {isLoading && (
        <div className="text-center py-12">
          <div className="inline-block w-12 h-12 border-4 border-[#97B3AE]/25 border-t-[#97B3AE] rounded-full animate-spin mb-6" />
          <p className="text-[#6a6a6a]">Generating your demo...</p>
          {pollCount >= MAX_POLLS && (
            <p className="text-sm text-[#9a948a] mt-2">
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
                <div
                  className="w-12 h-12 mx-auto mb-4 rounded-full bg-[#F2C3B9]/40 flex items-center justify-center"
                  role="img"
                  aria-label="warning"
                >
                  <svg
                    className="w-6 h-6 text-[#2a2a2a]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v4m0 4h.01M10.29 3.86l-8.48 14.7A1 1 0 002.67 20h18.66a1 1 0 00.86-1.44l-8.48-14.7a1 1 0 00-1.74 0z"
                    />
                  </svg>
                </div>
                <p className="text-[#6a6a6a] mb-4">
                  We couldn&apos;t generate a sample demo this time.
                </p>
                <button
                  onClick={handleRegenerate}
                  className="bg-white border border-[#97B3AE]/30 text-[#2a2a2a] font-medium py-2 px-6 rounded-full hover:bg-[#F0EEEA] mb-2 transition"
                >
                  Try the demo again
                </button>
              </>
            ) : (
              <p className="text-[#6a6a6a]">
                Your live demo is on the way after signup — for now, you can
                still subscribe.
              </p>
            )}
          </div>

          {/* Paywall stays available even when the demo isn't — never block payment on a transient generation issue. */}
          <div className="bg-[#F0EEEA] rounded-2xl border border-[#97B3AE]/15 p-6 sm:p-8 text-center">
            <h2 className="text-xl font-medium text-[#2a2a2a] mb-2">
              Choose your RepWorth plan
            </h2>
            <p className="text-[#6a6a6a] mb-6 max-w-md mx-auto">
              Subscribe to start automatically generating responses for every
              review.
            </p>
            <motion.a
              href="/onboarding/pay"
              onClick={() => {
                void captureDemoToSignup();
              }}
              {...buttonMotion}
              className={`inline-block ${primaryButtonClass}`}
            >
              Choose a plan →
            </motion.a>
          </div>
        </div>
      )}

      {isCompleted && (
        <div className="space-y-6">
          {reviews.map((review, index) => (
            <ReviewCard
              key={index}
              review={review}
              response={responses[index] ?? null}
            />
          ))}

          <div className="bg-[#F0EEEA] rounded-2xl border border-[#97B3AE]/15 p-6 sm:p-8 text-center mt-8">
            <h2 className="text-xl font-medium text-[#2a2a2a] mb-2">
              Want this for every review?
            </h2>
            <p className="text-[#6a6a6a] mb-6 max-w-md mx-auto">
              Subscribe to RepWorth and we&apos;ll automatically generate
              responses for all your reviews.
            </p>
            <motion.a
              href="/onboarding/pay"
              onClick={() => {
                void captureDemoToSignup();
              }}
              {...buttonMotion}
              className={`inline-block ${primaryButtonClass}`}
            >
              Choose a plan →
            </motion.a>
          </div>

          <div className="text-center">
            <button
              onClick={handleRegenerate}
              className="text-sm text-[#97B3AE] hover:text-[#7e9b96] underline"
            >
              Regenerate demo
            </button>
          </div>
        </div>
      )}
    </OnboardingFunnelShell>
  );
}

async function captureDemoToSignup() {
  await fetch('/api/analytics/enqueue', {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventName: 'sample_demo_to_signup',
      clientEventId: makeClientEventId(),
      properties: { source: 'onboarding_demo' },
    }),
  }).catch(() => undefined);
}

function makeClientEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < rating ? 'text-[#97B3AE]' : 'text-[#cdd9ce]'}>
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
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <div className="bg-white rounded-2xl border border-[#97B3AE]/15 shadow-sm overflow-hidden">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between mb-2">
          <div>
            <span className="font-semibold text-[#2a2a2a]">
              {review.reviewerName}
            </span>
            <span className="text-sm text-[#9a948a] ml-2">{formattedDate}</span>
          </div>
        </div>
        <Stars rating={review.starRating} />
        {review.reviewText ? (
          <p className="mt-2 text-[#6a6a6a] text-sm leading-relaxed">
            {review.reviewText}
          </p>
        ) : (
          <p className="mt-2 text-[#9a948a] text-sm italic">
            Rating only — no written review
          </p>
        )}
      </div>
      {response && (
        <div className="bg-[#F0EEEA] border-t border-[#97B3AE]/15 p-4 sm:p-5">
          <p className="text-xs font-semibold text-[#97B3AE] uppercase tracking-wider mb-2">
            RepWorth draft response
          </p>
          <p className="text-[#6a6a6a] text-sm leading-relaxed">
            {response.responseText}
          </p>
        </div>
      )}
    </div>
  );
}
