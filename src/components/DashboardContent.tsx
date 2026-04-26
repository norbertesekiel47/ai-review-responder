'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DashboardData, DashboardDataActive } from '@/lib/dashboard/types';
import {
  ActivePendingBusinessScreen,
  PendingAdminHandoffScreen,
  PendingPaymentScreen,
} from '@/components/dashboard/AccountStateScreens';
import { ValueSummary } from '@/components/dashboard/ValueSummary';
import { ReviewVelocityChart, RankingChart } from '@/components/dashboard/Charts';
import { ReviewActions } from '@/components/dashboard/ReviewActions';

const STATUS_BADGE_COLORS: Record<string, string> = {
  new: 'bg-gray-100 text-gray-700',
  generating: 'bg-gray-100 text-gray-700',
  pending_approval: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-blue-100 text-blue-800',
  edited: 'bg-blue-100 text-blue-800',
  awaiting_manual_post: 'bg-orange-100 text-orange-800',
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
  return '\u2605'.repeat(filled) + '\u2606'.repeat(5 - filled);
}

export function DashboardContent() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedReview, setExpandedReview] = useState<string | null>(null);

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const json: DashboardData = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <div className="rounded-lg border border-red-300 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-800">Error</h2>
          <p className="mt-1 text-sm text-red-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500">Loading dashboard...</p>
      </div>
    );
  }

  if (data.subscriptionStatus === 'active_pending_business') {
    return <ActivePendingBusinessScreen />;
  }

  if (data.subscriptionStatus === 'pending_payment_admin_handoff') {
    return <PendingAdminHandoffScreen />;
  }

  if (data.subscriptionStatus === 'pending_payment') {
    return <PendingPaymentScreen data={data} />;
  }

  const activeData: DashboardDataActive = data;
  const { valueSummary, reviewVelocity, ranking, recentReviews, latestBrief } = activeData;

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-8">
      {/* Section A: Value Summary Banner */}
      <ValueSummary valueSummary={valueSummary} />

      {/* Section B: Review Velocity Chart */}
      <ReviewVelocityChart reviewVelocity={reviewVelocity} />

      {/* Section C: Ranking Chart */}
      <RankingChart ranking={ranking} />

      {/* Section D: Recent Reviews */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Recent Reviews</h2>
        {recentReviews.length === 0 ? (
          <p className="text-sm text-gray-500">No reviews yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {recentReviews.map((review) => {
              const badgeClass =
                STATUS_BADGE_COLORS[review.responseStatus ?? review.status] ??
                STATUS_BADGE_COLORS.new;
              const displayStatus = review.responseStatus ?? review.status;
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
                      {review.responseStatus === 'pending_approval' && review.responseText && (
                        <ReviewActions
                          reviewId={review.id}
                          responseText={review.responseText}
                          onSuccess={fetchDashboard}
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

      {/* Section E: Latest Intelligence Brief */}
      {latestBrief && (
        <div className="rounded-lg border-l-4 border-blue-500 bg-blue-50 p-6">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-900">Intelligence Brief</h2>
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
              {latestBrief.type === 'monthly' ? 'Monthly' : 'Weekly'}
            </span>
          </div>
          <p className="mb-2 text-xs text-gray-500">{latestBrief.periodLabel}</p>
          <p className="whitespace-pre-line text-sm text-gray-700">{latestBrief.text}</p>
        </div>
      )}
    </div>
  );
}
