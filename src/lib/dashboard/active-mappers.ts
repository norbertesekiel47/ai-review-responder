import type { DashboardDataActive } from './types';
import type { ApprovalMethod } from '@/lib/auto-approval/types';
import type { OpenEscalationStatus } from '@/lib/escalations/types';
import type { TriageSeverity } from '@/lib/reviews/triage-schema';

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

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/**
 * Normalizes a Postgres `date` column (always `gs::date` for week buckets) to an
 * ISO `YYYY-MM-DD` string.
 *
 * postgres.js decodes `date` (OID 1082) with `new Date(x)`, so the raw value is a
 * JS Date at UTC midnight and `String(...)` yields
 * `"Mon Jun 22 2026 00:00:00 GMT+0000 (…)"` — a display string that is
 * process-timezone-dependent AND, under any string comparison, orders by month
 * NAME (`Aug` < `Jul` < `Jun`). That is #791: the All-Locations combined velocity
 * series, the one place a week key is re-sorted in JS, plotted its weeks out of
 * order. Carrying the ISO day makes ordering correct by construction rather than
 * patching the one sort site.
 *
 * Extracts the UTC calendar day, which round-trips the SQL date exactly — the
 * Date was parsed from a date-only string, so it is UTC midnight by construction.
 */
export function toIsoWeekStart(value: unknown): string {
  if (value == null) return '';
  // Already date-only (a `::text` cast or a test fixture) — no Date round-trip.
  if (typeof value === 'string' && ISO_DATE_PREFIX.test(value)) return value.slice(0, 10);

  const parsed = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

export function mapReviewVelocity(
  rows: Array<{ week_start: unknown; count: unknown }>,
): DashboardDataActive['reviewVelocity'] {
  return rows.map((row) => ({
    weekStart: toIsoWeekStart(row.week_start),
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
    autoPostScheduledAt: (row.auto_post_scheduled_at as Date | string) ?? null,
    escalation: row.escalation_id
      ? {
          id: row.escalation_id as string,
          status: row.escalation_status as OpenEscalationStatus,
          severity: row.escalation_severity as TriageSeverity,
        }
      : null,
  }));
}
