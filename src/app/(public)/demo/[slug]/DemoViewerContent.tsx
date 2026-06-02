'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

interface DemoViewerContentProps {
  businessName: string;
  reviews: NormalizedReview[];
  responses: (GenerationResult | null)[];
  selfServeEnabled: boolean;
}

export function DemoViewerContent({ businessName, reviews, responses, selfServeEnabled }: DemoViewerContentProps) {
  const successCount = responses.filter((r) => r !== null).length;

  const languages = new Set<string>();
  for (const review of reviews) languages.add(review.detectedLanguage);
  for (const response of responses) if (response) languages.add(response.language);
  const languageCount = languages.size;

  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />

      {/* Hero */}
      <div className="px-8 pt-12 pb-8 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-3xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
          >
            <p className="text-sm tracking-wider uppercase text-[#97B3AE] mb-3">RepWorth demo</p>
            <h1 className="text-4xl md:text-5xl font-medium leading-tight text-[#2a2a2a] mb-5">
              {businessName}
            </h1>
            <div className="flex flex-wrap gap-2">
              <StatChip>{reviews.length} reviews</StatChip>
              <StatChip>{successCount} replies drafted</StatChip>
              {languageCount > 1 && <StatChip>{languageCount} languages handled</StatChip>}
            </div>
          </motion.div>
        </div>
      </div>

      {/* Feed */}
      <div className="px-8 pb-12 bg-white">
        <div className="max-w-3xl mx-auto space-y-6">
          {reviews.map((review, index) => (
            <ReviewCard
              key={reviewKey(review)}
              review={review}
              response={responses[index] ?? null}
              index={index}
            />
          ))}
        </div>
      </div>

      {/* CTA */}
      <section className="px-8 py-14 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem] text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.6 }}
          className="max-w-xl mx-auto"
        >
          <h2 className="text-2xl md:text-3xl font-medium mb-3">Want replies like these for your reviews?</h2>
          <p className="text-white/85 mb-8">RepWorth drafts every reply — you approve before it posts.</p>
          <motion.div whileHover={{ scale: 1.05, y: -2 }} whileTap={{ scale: 0.98 }} className="inline-block">
            <Link
              href="/book-a-demo"
              className="inline-block px-8 py-4 bg-white text-[#97B3AE] rounded-full shadow-lg font-medium"
            >
              Book a demo
            </Link>
          </motion.div>
        </motion.div>
      </section>
    </PageShell>
  );
}

// NormalizedReview has no id field, so derive a stable key from its content.
// reviewerName + date + rating + text uniquely identifies a demo review.
function reviewKey(review: NormalizedReview): string {
  return `${review.reviewerName}|${review.reviewDate}|${review.starRating}|${review.reviewText ?? ''}`;
}

function StatChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-sm text-[#6a6a6a] bg-[#F0EEEA] border border-[#97B3AE]/25 rounded-full px-4 py-1.5">
      {children}
    </span>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < rating ? 'text-[#97B3AE]' : 'text-[#2a2a2a]/15'}>
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
}: {
  review: NormalizedReview;
  response: GenerationResult | null;
  index: number;
}) {
  const isMultilingual =
    review.detectedLanguage !== 'en' || (response !== null && response.language !== 'en');

  const formattedDate = new Date(review.reviewDate).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <motion.div
      className="bg-white rounded-2xl border border-[#97B3AE]/10 shadow-lg"
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.6, delay: index * 0.1 }}
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between mb-2 gap-3">
          <div>
            <span className="font-medium text-[#2a2a2a]">{review.reviewerName}</span>
            <span className="text-sm text-[#97B3AE] ml-2">{formattedDate}</span>
          </div>
          {isMultilingual && (
            <span className="text-xs font-medium bg-[#97B3AE]/15 text-[#97B3AE] px-2.5 py-0.5 rounded-full shrink-0">
              Multilingual
            </span>
          )}
        </div>
        <Stars rating={review.starRating} />
        {review.reviewText ? (
          <p className="mt-3 text-[#6a6a6a] leading-relaxed">{review.reviewText}</p>
        ) : (
          <p className="mt-3 text-[#6a6a6a]/70 italic">Rating only — no written review</p>
        )}
      </div>

      {response && (
        <div className="bg-[#F0EEEA] border-t border-[#97B3AE]/20 p-5 sm:p-6 rounded-b-2xl">
          <p className="text-xs font-semibold text-[#97B3AE] uppercase tracking-wider mb-2">RepWorth reply</p>
          <p className="text-[#6a6a6a] leading-relaxed">{response.responseText}</p>
        </div>
      )}
    </motion.div>
  );
}
