import type { DashboardDataActive } from './types';
import type { ApprovalMethod } from '@/lib/auto-approval/types';

function toReviewDateIso(value: unknown): string {
  if (!value) return '';

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  }

  return '';
}

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
    reviewDate: toReviewDateIso(row.review_date),
    status: row.status as string,
    responseText: (row.response_text as string) ?? null,
    responseStatus: (row.response_status as string) ?? null,
    approvalMethod: (row.approval_method as ApprovalMethod) ?? null,
  }));
}
