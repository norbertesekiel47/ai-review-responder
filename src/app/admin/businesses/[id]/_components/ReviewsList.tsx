'use client';

import type { ReviewRow } from '../types';
import { ADMIN_TIME_ZONE_LABEL, formatAdminDate } from '@/components/admin/ui/format';

const RESPONSE_BADGE_COLORS: Record<string, string> = {
  new: 'bg-gray-100 text-gray-600',
  pending_approval: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-blue-100 text-blue-800',
  edited: 'bg-blue-100 text-blue-800',
  awaiting_owner_connect: 'bg-gray-100 text-gray-700',
  posted: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

function formatStars(rating: number): string {
  // Clamp to [0, 5] integer range — '★'.repeat() throws RangeError on
  // negative counts, so a malformed row with rating > 5 or < 0 would
  // crash the entire reviews list.
  const clamped = Math.max(0, Math.min(5, Math.floor(Number.isFinite(rating) ? rating : 0)));
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped);
}

function ResponseBadge({ status }: { status: string | null }) {
  const displayStatus = status ?? 'new';
  const colorClass = RESPONSE_BADGE_COLORS[displayStatus] ?? 'bg-gray-100 text-gray-700';

  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${colorClass}`}>
      {displayStatus.replace(/_/g, ' ')}
    </span>
  );
}

interface ReviewsListProps {
  reviews: ReviewRow[];
  totalCount: number;
}

export function ReviewsList({ reviews, totalCount }: ReviewsListProps) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-gray-800">
        Reviews ({totalCount})
        {totalCount > reviews.length ? (
          <span className="ml-2 text-sm font-normal text-gray-400">
            showing latest {reviews.length}
          </span>
        ) : null}
      </h2>
      {reviews.length === 0 ? (
        <p className="mt-2 text-sm text-gray-400">No reviews found.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {reviews.map((review) => (
            <div
              key={review.id}
              className="rounded-lg border border-gray-200 bg-white p-4"
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="text-rw-teal">{formatStars(review.starRating)}</span>
                <span className="font-medium text-gray-700">{review.reviewerName}</span>
                {review.reviewDate && (
                  <span className="text-gray-400">
                    {formatAdminDate(review.reviewDate)} {ADMIN_TIME_ZONE_LABEL}
                  </span>
                )}
                {review.detectedLanguage && (
                  <span className="text-gray-400 uppercase text-xs">
                    [{review.detectedLanguage}]
                  </span>
                )}
                <ResponseBadge status={review.responseStatus} />
                {review.approvalMethod === 'auto_policy' && (
                  <span className="inline-block rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                    auto
                  </span>
                )}
              </div>
              {review.reviewText && (
                <p className="mt-1 text-sm text-gray-600 line-clamp-3">
                  {review.reviewText}
                </p>
              )}
              {review.approvedText && (
                <div className="mt-2 rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
                  <span className="font-medium text-blue-700">Response: </span>
                  {review.approvedText}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
