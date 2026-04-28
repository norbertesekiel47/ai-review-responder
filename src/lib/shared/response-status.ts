// ── responses.status — centralized status groups ───────────────────────
//
// Single source of truth for the named status groupings used across
// dashboard metrics, admin counts, weekly/monthly summaries, and
// onboarding/engagement queries. Keeping this list in one place ensures
// new statuses (like `awaiting_owner_connect` from the Zernio integration)
// are counted consistently everywhere `awaiting_manual_post` is.
//
// IMPORTANT: state-transition UPDATEs (e.g. mark-posted route, the
// ResponsePublisherWorker UPDATEs) keep their own narrow inline lists.
// Only counting/display callsites should use these groups.

// All response status values — the canonical enumeration.
export const ALL_RESPONSE_STATUSES = [
  'pending_approval',
  'approved',
  'edited',
  'superseded',
  'awaiting_manual_post',
  'awaiting_owner_connect',
  'posted',
  'failed',
] as const;

export type ResponseStatus = (typeof ALL_RESPONSE_STATUSES)[number];

// Non-terminal statuses — at most one such response can exist per review
// at a time (enforced by the partial unique index in migration 023+026).
export const NON_TERMINAL_STATUSES = [
  'pending_approval',
  'approved',
  'edited',
  'awaiting_manual_post',
  'awaiting_owner_connect',
] as const;

// Terminal statuses — a response in one of these states is settled and
// will not transition further (except admin-driven cleanup).
export const TERMINAL_STATUSES = [
  'superseded',
  'posted',
  'failed',
] as const;

// "Handled" — the owner has acted on the response so the review counts as
// responded for dashboard / response-rate / weekly-summary purposes.
// Includes published (`posted`), parked-pre-publish (`awaiting_manual_post`,
// `awaiting_owner_connect`), and approved-but-still-rendering (`approved`,
// `edited`).
export const HANDLED_STATUSES = [
  'approved',
  'edited',
  'awaiting_manual_post',
  'awaiting_owner_connect',
  'posted',
] as const;

// Same set as HANDLED_STATUSES — every "approved or later" status is by
// definition handled by the owner. Kept as a separate name because some
// callsites read more naturally with this label (e.g. notification
// approval-rate calculations).
export const APPROVED_OR_LATER_STATUSES = HANDLED_STATUSES;

// Subset between owner approval and successful publish — used for
// "draft is queued, awaiting publish" displays. Does NOT include
// `pending_approval` (owner hasn't acted yet) or `posted` (already done).
export const AWAITING_PUBLISH_STATUSES = [
  'approved',
  'edited',
  'awaiting_manual_post',
  'awaiting_owner_connect',
] as const;

// "Recent reviews" display set — the latest non-superseded/non-failed
// response per review, including pending so the dashboard can surface
// "check your email" reminders.
export const RECENT_REVIEW_DISPLAY_STATUSES = [
  'pending_approval',
  'approved',
  'edited',
  'awaiting_manual_post',
  'awaiting_owner_connect',
  'posted',
] as const;
