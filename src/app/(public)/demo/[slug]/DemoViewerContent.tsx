'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

interface DemoViewerContentProps {
  businessName: string;
  reviews: NormalizedReview[];
  responses: (GenerationResult | null)[];
  selfServeEnabled: boolean;
}

export function DemoViewerContent({ businessName, reviews, responses, selfServeEnabled }: DemoViewerContentProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const successCount = responses.filter((r) => r !== null).length;
  const hasReviews = reviews.length > 0;
  const repliesStillGenerating = hasReviews && successCount < reviews.length;

  const languages = new Set<string>();
  for (const review of reviews) languages.add(review.detectedLanguage);
  for (const response of responses) if (response) languages.add(response.language);
  const languageCount = languages.size;

  const heroReveal = prefersReducedMotion
    ? {}
    : {
        initial: { opacity: 0, y: 20 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.6, delay: 0.2 },
      };

  const ctaReveal = prefersReducedMotion
    ? {}
    : {
        initial: { opacity: 0, y: 20 },
        whileInView: { opacity: 1, y: 0 },
        viewport: { once: true, margin: '-100px' },
        transition: { duration: 0.6 },
      };

  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />

      <main id="main-content">
      {/* Hero */}
      <div className="px-8 pt-12 pb-8 bg-gradient-to-b from-white to-rw-cream/30">
        <div className="max-w-3xl mx-auto">
          <motion.div {...heroReveal}>
            <p className="text-sm tracking-wider uppercase text-rw-teal-strong mb-3">RepWorth demo</p>
            <h1 className="text-4xl md:text-5xl font-medium leading-tight text-rw-ink mb-5">
              {businessName}
            </h1>
            {hasReviews && (
              <div className="flex flex-wrap gap-2">
                <StatChip>{reviews.length} reviews</StatChip>
                {successCount > 0 && <StatChip>{successCount} replies drafted</StatChip>}
                {languageCount > 1 && <StatChip>{languageCount} languages handled</StatChip>}
              </div>
            )}
            {repliesStillGenerating && (
              <p className="mt-3 text-sm text-rw-teal-strong italic">Some replies are still generating.</p>
            )}
          </motion.div>
        </div>
      </div>

      {/* Feed */}
      <div className="px-8 pb-12 bg-white">
        <div className="max-w-3xl mx-auto space-y-6">
          {hasReviews ? (
            reviews.map((review, index) => (
              <ReviewCard
                key={reviewKey(review)}
                review={review}
                response={responses[index] ?? null}
                index={index}
                prefersReducedMotion={prefersReducedMotion}
              />
            ))
          ) : (
            <EmptyState />
          )}
        </div>
      </div>

      {/* CTA */}
      <section className="px-8 py-14 bg-gradient-to-br from-rw-teal-strong to-rw-teal-strong/85 text-white rounded-b-[3rem] text-center">
        <motion.div {...ctaReveal} className="max-w-xl mx-auto">
          <h2 className="text-2xl md:text-3xl font-medium mb-3">Want replies like these for your reviews?</h2>
          <p className="text-white/90 mb-8">RepWorth drafts every reply — you approve before it posts.</p>
          <motion.div
            whileHover={prefersReducedMotion ? undefined : { scale: 1.05, y: -2 }}
            whileTap={prefersReducedMotion ? undefined : { scale: 0.98 }}
            className="inline-block"
          >
            <Link
              href="/book-a-demo"
              className="inline-block px-8 py-4 bg-white text-rw-teal-strong rounded-full shadow-lg font-medium"
            >
              Book a demo
            </Link>
          </motion.div>
        </motion.div>
      </section>
      </main>
    </PageShell>
  );
}

function EmptyState() {
  return (
    <div className="py-16 flex flex-col items-center text-center">
      <div
        aria-hidden="true"
        className="w-16 h-16 rounded-full bg-rw-teal-strong/15 flex items-center justify-center mb-6"
      >
        <svg className="w-7 h-7 text-rw-teal-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
          />
        </svg>
      </div>
      <h2 className="text-xl font-medium text-rw-ink mb-2">No reviews to show yet</h2>
      <p className="text-rw-ink-soft max-w-md">
        We couldn&apos;t find public reviews for this business to draft replies from. Book a demo and
        we&apos;ll show you RepWorth on real reviews from your account.
      </p>
    </div>
  );
}

// NormalizedReview has no id field, so derive a stable key from its content.
// reviewerName + date + rating + text uniquely identifies a demo review.
function reviewKey(review: NormalizedReview): string {
  return `${review.reviewerName}|${review.reviewDate}|${review.starRating}|${review.reviewText ?? ''}`;
}

function StatChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-sm text-rw-teal-strong bg-rw-cream border border-rw-teal-strong/25 rounded-full px-4 py-1.5">
      {children}
    </span>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} aria-hidden="true" className={i < rating ? 'text-rw-teal-strong' : 'text-rw-ink/15'}>
          ★
        </span>
      ))}
    </span>
  );
}

function ReviewCard({
  review,
  response,
  index,
  prefersReducedMotion,
}: {
  review: NormalizedReview;
  response: GenerationResult | null;
  index: number;
  prefersReducedMotion: boolean;
}) {
  const isMultilingual =
    review.detectedLanguage !== 'en' || (response !== null && response.language !== 'en');

  const formattedDate = new Date(review.reviewDate).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const cardReveal = prefersReducedMotion
    ? {}
    : {
        initial: { opacity: 0, y: 20 },
        whileInView: { opacity: 1, y: 0 },
        viewport: { once: true, margin: '-100px' },
        transition: { duration: 0.6, delay: index * 0.1 },
      };

  return (
    <motion.div className="bg-white rounded-2xl border border-rw-teal-strong/10 shadow-lg" {...cardReveal}>
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between mb-2 gap-3">
          <div>
            <span className="font-medium text-rw-ink">{review.reviewerName}</span>
            <span className="text-sm text-rw-teal-strong ml-2">{formattedDate}</span>
          </div>
          {isMultilingual && (
            <span className="text-xs font-medium bg-rw-teal-strong/15 text-rw-teal-strong px-2.5 py-0.5 rounded-full shrink-0">
              Multilingual
            </span>
          )}
        </div>
        <Stars rating={review.starRating} />
        {review.reviewText ? (
          <p className="mt-3 text-rw-ink-soft leading-relaxed">{review.reviewText}</p>
        ) : (
          <p className="mt-3 text-rw-ink-soft/70 italic">Rating only — no written review</p>
        )}
      </div>

      {response && (
        <div className="bg-rw-cream border-t border-rw-teal-strong/20 p-5 sm:p-6 rounded-b-2xl">
          <p className="text-xs font-semibold text-rw-teal-strong uppercase tracking-wider mb-2">RepWorth reply</p>
          <p className="text-rw-ink-soft leading-relaxed">{response.responseText}</p>
        </div>
      )}
    </motion.div>
  );
}
