'use client';

import ManualPostSection from '../manual-post-section';
import type { ReviewRow } from '../types';

interface ManualPostFlowProps {
  businessId: string;
  awaitingPost: ReviewRow[];
}

/**
 * Type guard: a ReviewRow is renderable for manual posting only if both
 * responseId and approvedText are present. The DB query that produces
 * `awaiting_manual_post` rows always populates both, but defending here
 * removes the non-null `!` assertions and prevents an empty-string key
 * collision if a malformed row ever slips through.
 */
function isPostable(r: ReviewRow): r is ReviewRow & { responseId: string; approvedText: string } {
  return typeof r.responseId === 'string' && r.responseId.length > 0
    && typeof r.approvedText === 'string' && r.approvedText.length > 0;
}

export function ManualPostFlow({ businessId, awaitingPost }: ManualPostFlowProps) {
  const postable = awaitingPost.filter(isPostable);
  if (postable.length === 0) {
    return null;
  }

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-gray-800">
        Awaiting Manual Post ({postable.length})
      </h2>
      <div className="mt-4 space-y-4">
        {postable.map((r) => (
          <ManualPostSection
            key={r.responseId}
            responseId={r.responseId}
            businessId={businessId}
            reviewerName={r.reviewerName}
            starRating={r.starRating}
            reviewText={r.reviewText}
            approvedText={r.approvedText}
          />
        ))}
      </div>
    </section>
  );
}
