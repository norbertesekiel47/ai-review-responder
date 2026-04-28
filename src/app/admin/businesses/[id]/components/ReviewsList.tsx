'use client';

import type { ReviewRow } from '../types';

function renderStars(rating: number): string {
  // Clamp to [0, 5] integer range — '★'.repeat() throws RangeError on
  // negative counts, so a malformed row with rating > 5 or < 0 would
  // crash the entire reviews list.
  const clamped = Math.max(0, Math.min(5, Math.floor(Number.isFinite(rating) ? rating : 0)));
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped);
}

function ResponseBadge({ status }: { status: string | null }) {
  const displayStatus = status ?? 'new';

  const colorMap: Record<string, string> = {
    new: 'bg-gray-100 text-gray-600',
    pending_approval: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-blue-100 text-blue-800',
    edited: 'bg-blue-100 text-blue-800',
    awaiting_manual_post: 'bg-orange-100 text-orange-800',
    awaiting_owner_connect: 'bg-amber-100 text-amber-800',
    posted: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
  };

  const colorClass = colorMap[displayStatus] ?? 'bg-gray-100 text-gray-700';

  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${colorClass}`}>
      {displayStatus.replace(/_/g, ' ')}
    </span>
  );
}

interface ReviewsListProps {
  reviews: ReviewRow[];
}

export function ReviewsList({ reviews }: ReviewsListProps) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-gray-800">
        Reviews ({reviews.length})
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
                <span className="text-yellow-500">{renderStars(review.starRating)}</span>
                <span className="font-medium text-gray-700">{review.reviewerName}</span>
                {review.reviewDate && (
                  <span className="text-gray-400">
                    {new Date(review.reviewDate).toLocaleDateString()}
                  </span>
                )}
                {review.detectedLanguage && (
                  <span className="text-gray-400 uppercase text-xs">
                    [{review.detectedLanguage}]
                  </span>
                )}
                <ResponseBadge status={review.responseStatus} />
              </div>
              {review.reviewText && (
                <p className="mt-1 text-sm text-gray-600 line-clamp-3">
                  {review.reviewText}
                </p>
              )}
              {review.approvedText && (
                <div className="mt-2 rounded bg-blue-50 px-3 py-2 text-sm text-gray-800">
                  <span className="font-medium text-gray-500">Response: </span>
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
