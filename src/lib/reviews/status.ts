// Canonical reviews.status vocabulary — the single owner (mirrors the schema
// comment in 001_initial_schema.sql plus 'deleted'). 'deleted' has never been
// added to the schema comment or given a CHECK constraint (reviews.status is
// a plain VARCHAR(20), no CHECK) — it was introduced as an application-code
// convention by commit 56636f91 ("feat(multi-location): per-account
// multi-location support + Stripe overage", PR #28), which taught
// ZernioRecentReviewPoller to soft-delete a review by writing
// status = 'deleted' instead of removing the row.
// Import these; never re-spell a review-status literal (guard:
// scripts/ci/reviews-status-audit.ts). The reviews-table sibling of
// shared/response-status.ts.
//
// AWAITING_MANUAL_POST note: this is a DIFFERENT column from
// responses.status, whose own 'awaiting_manual_post' value was decommissioned
// by migration 029_drop_awaiting_manual_post.sql. That migration only touched
// `responses` (UPDATE + index rebuild) and never updated the shorter
// `reviews.status` schema comment this module mirrors. No current code path
// writes 'awaiting_manual_post' to reviews.status, but reviews.status has no
// CHECK constraint (it's a plain VARCHAR(20)) so nothing enforces the
// vocabulary either way — kept for schema-comment fidelity since this task is
// behavior-preserving; revisit in the Stage-2 adoption sweep if it proves
// truly dead.
export const REVIEW_STATUS = {
  NEW: 'new',
  GENERATING: 'generating',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  AWAITING_MANUAL_POST: 'awaiting_manual_post',
  POSTED: 'posted',
  FAILED: 'failed',
  DELETED: 'deleted',
} as const;

export type ReviewStatus = (typeof REVIEW_STATUS)[keyof typeof REVIEW_STATUS];
