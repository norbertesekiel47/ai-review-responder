'use client';

import ManualPostSection from '../manual-post-section';
import type { ReviewRow } from '../types';

interface ManualPostFlowProps {
  businessId: string;
  awaitingPost: ReviewRow[];
}

export function ManualPostFlow({ businessId, awaitingPost }: ManualPostFlowProps) {
  if (awaitingPost.length === 0) {
    return null;
  }

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-gray-800">
        Awaiting Manual Post ({awaitingPost.length})
      </h2>
      <div className="mt-4 space-y-4">
        {awaitingPost.map((r) => (
          <ManualPostSection
            key={r.responseId}
            responseId={r.responseId!}
            businessId={businessId}
            reviewerName={r.reviewerName}
            starRating={r.starRating}
            reviewText={r.reviewText}
            approvedText={r.approvedText!}
          />
        ))}
      </div>
    </section>
  );
}
