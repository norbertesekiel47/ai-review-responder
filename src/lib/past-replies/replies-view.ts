import type { ApprovalMethod } from '@/lib/auto-approval/types';
import type { PastReplyRow } from '@/components/dashboard/reviews/PastReplyCard';

/** Posted-reply page size — also the pagination denominator. */
export const PAGE_SIZE = 50;

/** Posted row + the LATERAL recoverable-failure sidecar (main-query shape). */
export interface ReviewRow {
  review_id: string;
  review_text: string | null;
  review_date: Date;
  response_id: string;
  approved_text: string | null;
  approval_method: ApprovalMethod | null;
  posted_at: Date | null;
  external_reply_ingested_at: Date | null;
  // Optimistic-concurrency snapshot fields.
  review_content_hash: string | null;
  version: number | null;
  star_rating: number | null;
  reviewer_name: string | null;
  // Failed-sibling sidecar from the LATERAL join.
  failed_response_id: string | null;
  failed_posting_error: string | null;
}

/** Orphan-only recovery row (post_after_delete_failed_* with NO posted sibling). */
export interface OrphanRow {
  review_id: string;
  review_text: string | null;
  review_date: Date;
  star_rating: number | null;
  reviewer_name: string | null;
  review_content_hash: string | null;
  // The failed response is the primary identifier for orphan rows.
  failed_response_id: string;
  failed_posting_error: string;
  // The most-recent superseded sibling's text (drawer context). May be null.
  superseded_text: string | null;
}

/** Parse + clamp the `?page=` search param to a 1-based page number. */
export function parsePageParam(raw: string | undefined): number {
  const requested = parseInt(raw ?? '1', 10);
  return Math.max(1, Number.isFinite(requested) ? requested : 1);
}

// ── C-2 rule (mirrors assertCanEditReply exactly) ───────────────────────────
//   isHistorical = activated_at IS NULL OR review_date < activated_at
//   canEdit      = NOT isHistorical OR isPremium
//   Boundary: review_date == subscription_activated_at → gap (>= predicate).
export function isHistorical(reviewDate: Date, activatedAtIso: string | null): boolean {
  return (
    activatedAtIso === null ||
    new Date(reviewDate).getTime() < new Date(activatedAtIso).getTime()
  );
}

export function canEdit(
  reviewDate: Date,
  activatedAtIso: string | null,
  isPremium: boolean,
): boolean {
  return !isHistorical(reviewDate, activatedAtIso) || isPremium;
}

/** Postgres.js may hand back a Date or a string; normalize nullable ts → ISO. */
const toIso = (d: Date | null): string | null =>
  d instanceof Date ? d.toISOString() : d == null ? null : String(d);

/** Maps a posted ReviewRow → the PastReplyRow wire shape the card expects. */
export function toCardRow(
  r: ReviewRow,
  activatedAtIso: string | null,
  isPremium: boolean,
): PastReplyRow {
  return {
    review_id: r.review_id,
    review_text: r.review_text,
    review_date:
      r.review_date instanceof Date ? r.review_date.toISOString() : String(r.review_date),
    reviewer_name: r.reviewer_name,
    star_rating: r.star_rating,
    response_id: r.response_id,
    approved_text: r.approved_text,
    approval_method: r.approval_method,
    posted_at: toIso(r.posted_at),
    external_reply_ingested_at: toIso(r.external_reply_ingested_at),
    review_content_hash: r.review_content_hash,
    version: typeof r.version === 'number' ? r.version : null,
    // C-2 gate computed server-side.
    canEdit: canEdit(r.review_date, activatedAtIso, isPremium),
    failed_response_id: r.failed_response_id ?? null,
    failed_posting_error: r.failed_posting_error ?? null,
  };
}

// Maps an orphan-only row into the PastReplyRow shape, using the failed
// response's id as response_id so the card's key stays unique. Posted-only
// fields are null (the card guards them). canEdit is always true: the owner
// already approved + attempted this edit, so recovery must not be gated by the
// C-2 lock (the recovery branch takes precedence over the lock badge).
export function toOrphanCardRow(r: OrphanRow): PastReplyRow {
  return {
    review_id: r.review_id,
    review_text: r.review_text,
    review_date:
      r.review_date instanceof Date ? r.review_date.toISOString() : String(r.review_date),
    reviewer_name: r.reviewer_name,
    star_rating: r.star_rating,
    response_id: r.failed_response_id,
    approved_text: r.superseded_text ?? null,
    approval_method: null,
    posted_at: null,
    external_reply_ingested_at: null,
    review_content_hash: r.review_content_hash,
    version: null,
    canEdit: true,
    failed_response_id: r.failed_response_id,
    failed_posting_error: r.failed_posting_error,
  };
}

// Sort descending by review_date. String compare works: review_date is ISO-8601.
const sortByDateDesc = (a: PastReplyRow, b: PastReplyRow): number =>
  b.review_date.localeCompare(a.review_date);

export interface BucketedReplies {
  gapRows: PastReplyRow[];
  histRows: PastReplyRow[];
  orphanGapCount: number;
  orphanHistCount: number;
}

/**
 * Bucket posted + orphan rows into the gap ("active period") and historical
 * ("before you joined") sections by the C-2 historical predicate, merge, and
 * sort each section newest-first. De-dup is structural — the orphan query's
 * NOT EXISTS clause guarantees no review_id overlap with the posted rows.
 *
 * orphan{Gap,Hist}Count are returned so callers can decide section visibility:
 * orphan rows render but do NOT inflate the posted-only stat/pagination totals.
 */
export function bucketReplies(
  rows: readonly ReviewRow[],
  orphanRows: readonly OrphanRow[],
  activatedAtIso: string | null,
  isPremium: boolean,
): BucketedReplies {
  const postedGap = rows.flatMap((r) =>
    !isHistorical(r.review_date, activatedAtIso) ? [toCardRow(r, activatedAtIso, isPremium)] : [],
  );
  const postedHist = rows.flatMap((r) =>
    isHistorical(r.review_date, activatedAtIso) ? [toCardRow(r, activatedAtIso, isPremium)] : [],
  );
  const orphanGap = orphanRows.flatMap((r) =>
    !isHistorical(r.review_date, activatedAtIso) ? [toOrphanCardRow(r)] : [],
  );
  const orphanHist = orphanRows.flatMap((r) =>
    isHistorical(r.review_date, activatedAtIso) ? [toOrphanCardRow(r)] : [],
  );

  return {
    gapRows: [...postedGap, ...orphanGap].sort(sortByDateDesc),
    histRows: [...postedHist, ...orphanHist].sort(sortByDateDesc),
    orphanGapCount: orphanGap.length,
    orphanHistCount: orphanHist.length,
  };
}
