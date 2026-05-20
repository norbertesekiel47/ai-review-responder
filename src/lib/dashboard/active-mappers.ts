import type { DashboardDataActive } from './types';

export function mapReviewVelocity(
  rows: Array<{ week_start: unknown; count: unknown }>,
): DashboardDataActive['reviewVelocity'] {
  return rows.map((row) => ({
    weekStart: String(row.week_start),
    count: row.count as number,
  }));
}

export function mapRecentReviews(
  rows: Array<Record<string, unknown>>,
): DashboardDataActive['recentReviews'] {
  return rows.map((row) => ({
    id: row.id as string,
    reviewerName: (row.reviewer_name as string) ?? 'Anonymous',
    starRating: (row.star_rating as number) ?? null,
    reviewText: (row.review_text as string) ?? null,
    reviewDate: row.review_date ? (row.review_date as Date).toISOString() : '',
    status: row.status as string,
    responseText: (row.response_text as string) ?? null,
    responseStatus: (row.response_status as string) ?? null,
  }));
}
