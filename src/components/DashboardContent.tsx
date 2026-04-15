'use client';

import { useEffect, useState } from 'react';
import type { DashboardData } from '@/app/api/dashboard/route';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
  LineChart, Line, CartesianGrid,
} from 'recharts';

const STATUS_BADGE_COLORS: Record<string, string> = {
  new: 'bg-gray-100 text-gray-700',
  pending_approval: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-blue-100 text-blue-800',
  awaiting_manual_post: 'bg-orange-100 text-orange-800',
  posted: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-700',
};

const RANKING_LINE_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2',
];

function formatStatusLabel(status: string): string {
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatWeekLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  return `${month} ${day}`;
}

function renderStars(rating: number): string {
  const filled = Math.round(Math.max(0, Math.min(5, rating)));
  return '\u2605'.repeat(filled) + '\u2606'.repeat(5 - filled);
}

export function DashboardContent() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedReview, setExpandedReview] = useState<string | null>(null);

  useEffect(() => {
    async function fetchDashboard() {
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
    }
    fetchDashboard();
  }, []);

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

  const { valueSummary, reviewVelocity, ranking, recentReviews, latestBrief } = data;
  const timeSavedHours = Math.round((valueSummary.totalTimeSavedMinutes / 60) * 10) / 10;

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-8">
      {/* Section A: Value Summary Banner */}
      <div className="rounded-xl bg-gradient-to-r from-blue-600 to-blue-700 p-6 text-white shadow-lg">
        <p className="mb-4 text-sm font-medium text-blue-100">Since joining RepWorth</p>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <div>
            <p className="text-3xl font-bold">{valueSummary.totalReviewsHandled}</p>
            <p className="text-sm text-blue-100">Reviews handled</p>
          </div>
          <div>
            <p className="text-3xl font-bold">{timeSavedHours}h</p>
            <p className="text-sm text-blue-100">Time saved</p>
          </div>
          <div>
            <p className="text-3xl font-bold">{valueSummary.currentResponseRate}%</p>
            <p className="text-sm text-blue-100">
              Response rate
              {valueSummary.baselineResponseRate != null && (
                <span className="ml-1">
                  (was {valueSummary.baselineResponseRate}%)
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Section B: Review Velocity Chart */}
      {reviewVelocity.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Review Velocity</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={reviewVelocity}>
              <XAxis
                dataKey="weekStart"
                tickFormatter={formatWeekLabel}
                tick={{ fontSize: 12 }}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip
                labelFormatter={(label) => formatWeekLabel(String(label))}
                formatter={(value) => [String(value), 'Reviews']}
              />
              <Bar
                dataKey="count"
                fill="#2563eb"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Section C: Ranking Chart */}
      {ranking && ranking.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Search Ranking</h2>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                type="category"
                allowDuplicatedCategory={false}
                tickFormatter={formatWeekLabel}
                tick={{ fontSize: 12 }}
              />
              <YAxis
                reversed
                domain={[1, 'auto']}
                allowDecimals={false}
                tick={{ fontSize: 12 }}
                label={{ value: 'Rank', angle: -90, position: 'insideLeft', fontSize: 12 }}
              />
              <Tooltip labelFormatter={(label) => formatWeekLabel(String(label))} />
              {ranking.map((entry, idx) => (
                <Line
                  key={entry.keyword}
                  data={entry.snapshots}
                  dataKey="position"
                  name={entry.keyword}
                  stroke={RANKING_LINE_COLORS[idx % RANKING_LINE_COLORS.length]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

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
                        <span className="text-sm text-yellow-500" aria-label={`${review.starRating} stars`}>
                          {renderStars(review.starRating)}
                        </span>
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
                      {displayStatus === 'pending_approval' && (
                        <p className="mt-1 text-xs text-yellow-700">
                          Check your email to approve this response.
                        </p>
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
