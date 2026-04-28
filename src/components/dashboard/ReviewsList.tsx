'use client';

import { useState } from 'react';
import type { DashboardDataActive } from '@/lib/dashboard/types';
import { ReviewActions } from '@/components/dashboard/ReviewActions';

const STATUS_BADGE_COLORS: Record<string, string> = {
  new: 'bg-gray-100 text-gray-700',
  generating: 'bg-gray-100 text-gray-700',
  pending_approval: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-blue-100 text-blue-800',
  edited: 'bg-blue-100 text-blue-800',
  awaiting_manual_post: 'bg-orange-100 text-orange-800',
  awaiting_owner_connect: 'bg-amber-100 text-amber-800',
  posted: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-700',
};

function formatStatusLabel(status: string): string {
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderStars(rating: number): string {
  const filled = Math.round(Math.max(0, Math.min(5, rating)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

export function ReviewsList({
  recentReviews,
  onActionSuccess,
}: {
  recentReviews: DashboardDataActive['recentReviews'];
  onActionSuccess: () => void;
}) {
  const [expandedReview, setExpandedReview] = useState<string | null>(null);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-lg font-semibold text-gray-900">Recent Reviews</h2>
      {recentReviews.length === 0 ? (
        <p className="text-sm text-gray-500">No reviews yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {recentReviews.map((review) => {
            // Compute displayStatus once and use it for both badge color and
            // action gating. Previously the action gate read review.responseStatus
            // directly while the badge used responseStatus ?? status — an
            // inconsistency that's harmless today (the action gate uses the
            // exact 'pending_approval' literal) but would silently drift if
            // a status alias is ever introduced.
            const displayStatus = review.responseStatus ?? review.status;
            const badgeClass =
              STATUS_BADGE_COLORS[displayStatus] ?? STATUS_BADGE_COLORS.new;
            const isExpanded = expandedReview === review.id;

            return (
              <li key={review.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {review.starRating != null ? (
                        <span className="text-sm text-yellow-500" aria-label={`${review.starRating} stars`}>
                          {renderStars(review.starRating)}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">No rating</span>
                      )}
                      <span className="text-sm font-medium text-gray-900">
                        {review.reviewerName}
                      </span>
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass}`}>
                        {formatStatusLabel(displayStatus)}
                      </span>
                    </div>
                    {review.reviewText && (
                      <p className="mt-1 text-sm text-gray-600">{review.reviewText}</p>
                    )}
                    {displayStatus === 'pending_approval' && review.responseText && (
                      <ReviewActions
                        reviewId={review.id}
                        responseText={review.responseText}
                        onSuccess={onActionSuccess}
                      />
                    )}
                    {review.responseText && (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => setExpandedReview(isExpanded ? null : review.id)}
                          className="text-xs font-medium text-blue-600 hover:text-blue-800"
                        >
                          {isExpanded ? 'Hide response' : 'Show response'}
                        </button>
                        {isExpanded && (
                          <p className="mt-1 rounded-md bg-gray-50 p-3 text-sm text-gray-700">
                            {review.responseText}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
