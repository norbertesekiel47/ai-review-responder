import { APPROVAL_METHOD, type ApprovalMethod } from '@/lib/auto-approval/types';
import type { PastReplyRow } from '@/components/dashboard/reviews/PastReplyCard';

/** Reviews-list page size — also the pagination denominator. */
export const PAGE_SIZE = 50;

/**
 * One row of the SINGLE row source behind the Reviews list (#678, F3).
 *
 * `reviews` LEFT JOINed to the live posted reply plus four LATERAL sidecars, so
 * every review for the location appears exactly once — replied or not, orphan or
 * not. `response_id` is nullable precisely because the join is LEFT: `null` IS
 * the unanswered predicate, and `deriveRowState` depends on that fact. Do not
 * "simplify" it back to `string`.
 */
export interface ReviewRow {
  review_id: string;
  review_text: string | null;
  review_date: Date;
  // The live posted reply, or NULL when the review has never been answered.
  response_id: string | null;
  approved_text: string | null;
  approval_method: ApprovalMethod | null;
  posted_at: Date | null;
  external_reply_ingested_at: Date | null;
  // Optimistic-concurrency snapshot fields.
  review_content_hash: string | null;
  version: number | null;
  star_rating: number | null;
  reviewer_name: string | null;
  // delete_failed_* sibling of a still-live posted reply (fail_sidecar LATERAL).
  failed_response_id: string | null;
  failed_posting_error: string | null;
  // The live non-terminal draft, and whether moderation is holding it (draft LATERAL).
  draft_response_id: string | null;
  draft_held: boolean;
  // An in-flight generate_response outbox row (pending_gen LATERAL).
  generation_in_flight: boolean;
  // post_after_delete_failed_* sibling with NO live posted reply, plus the text
  // the owner approved before the failed edit (orphan_sidecar / orphan_superseded).
  is_orphan: boolean;
  orphan_failed_response_id: string | null;
  orphan_posting_error: string | null;
  superseded_text: string | null;
}

/** Parse + clamp the `?page=` search param to a 1-based page number. */
export function parsePageParam(raw: string | undefined): number {
  const requested = parseInt(raw ?? '1', 10);
  return Math.max(1, Number.isFinite(requested) ? requested : 1);
}

/**
 * `activated_at IS NULL OR review_date < activated_at`.
 *
 * Survives ONLY as an input to `provenanceBadge` (D-E). It is no longer a
 * bucketing predicate — #678 replaced the gap/historical sections with
 * Unanswered/Answered, which `deriveRowState` decides.
 */
export function isHistorical(reviewDate: Date, activatedAtIso: string | null): boolean {
  return (
    activatedAtIso === null ||
    new Date(reviewDate).getTime() < new Date(activatedAtIso).getTime()
  );
}

// Strict paid-tier edit gate. Both launch tiers may edit either provenance;
// an unknown stored tier fails closed upstream (load-replies throws).
export function canEdit(
  hasPaidTier: boolean,
): boolean {
  return hasPaidTier;
}

/**
 * What the row offers. Derived ONCE here so every "never offer Generate on X"
 * rule lives in one place — the card renders a state, it never computes one.
 * Order is precedence, not preference.
 */
export type ReviewRowState =
  | 'recover'      // orphan: repost failed, no live reply — /retry or /restore-original
  | 'regenerate'   // posted sibling exists — EditReplyDrawer, replaces a LIVE Google reply
  | 'held'         // draft held by moderation — no text, no affordance (invariant #4)
  | 'draft_ready'  // live non-posted response — cross-link to Needs Action (S2)
  | 'generating'   // generate_response outbox row in flight
  | 'generate';    // never replied, nothing in flight

/**
 * Precedence, in order: an orphan has a superseded draft and must reach
 * recovery, never Generate (D-G); a posted sibling always means Regenerate; a
 * held draft outranks `draft_ready` because invariant #4 makes the hold
 * absolute — and it is tested on the SAME branch as `draft_ready` so a held
 * draft can never fall through to `generate` (D9), which would offer an LLM
 * spend the partial unique index (migrations 023+026+029) then rejects; a live
 * draft outranks an in-flight outbox row because the response row is the
 * settled fact.
 */
export function deriveRowState(r: {
  response_id: string | null;
  draft_response_id: string | null;
  draft_held: boolean;
  generation_in_flight: boolean;
  is_orphan: boolean;
}): ReviewRowState {
  if (r.is_orphan) return 'recover';
  if (r.response_id !== null) return 'regenerate';
  if (r.draft_response_id !== null) return r.draft_held ? 'held' : 'draft_ready';
  if (r.generation_in_flight) return 'generating';
  return 'generate';
}

/**
 * Axis A — the Posted-reply axis (#723/#727): what exists on Google for this
 * review. Owns the Unanswered/Answered grouping and the reply panel.
 */
export type ReplyState = 'none' | 'posted' | 'orphan';

/**
 * Axis B — the Replacement-draft axis: where the replacement workflow stands.
 * SERVER-INTERNAL — it never crosses the wire (invariant #4 as structure: the
 * client cannot leak what it never receives). Intra-axis precedence: a settled
 * response row outranks an in-flight outbox row (held > ready > generating >
 * none), same rationale as the pre-#727 single enum.
 */
export type DraftState = 'none' | 'generating' | 'ready' | 'held';

/**
 * The Action slot — the single affordance the card renders, derived from the
 * full 3×4 cross-product. A held draft never projects an affordance of its
 * own: none/posted×held → 'none'; orphan×held keeps 'recover' because the
 * affordance addresses the orphan incident, not the draft (#723 table).
 */
export type RowAction =
  | 'generate'
  | 'generating'
  | 'draft_ready'
  | 'regenerate'
  | 'recover'
  | 'none';

/** Same facts as deriveRowState → the two axes. */
export function deriveAxes(r: {
  response_id: string | null;
  draft_response_id: string | null;
  draft_held: boolean;
  generation_in_flight: boolean;
  is_orphan: boolean;
}): { reply: ReplyState; draft: DraftState } {
  // is_orphan already encodes resp.id IS NULL (load-replies, F3), so
  // orphan/posted exclusivity holds by construction of the row source.
  const reply: ReplyState = r.is_orphan ? 'orphan' : r.response_id !== null ? 'posted' : 'none';
  const draft: DraftState =
    r.draft_response_id !== null
      ? r.draft_held
        ? 'held'
        : 'ready'
      : r.generation_in_flight
        ? 'generating'
        : 'none';
  return { reply, draft };
}

/** (reply, draft) → the Action slot. Total over all 12 cells. */
export function deriveRowAction(reply: ReplyState, draft: DraftState): RowAction {
  switch (reply) {
    case 'orphan':
      // Recovery dominates EVERY draft state (#723 locked call): the
      // affordance addresses the orphan incident, never the draft — a held
      // draft stays invisible, and #726 owns the server-side hold checks the
      // recovery drawer could reach.
      return 'recover';
    case 'posted':
      // held withdraws the drawer (invariant #4); a pending or in-flight
      // replacement keeps Regenerate — the drawer itself resumes it.
      return draft === 'held' ? 'none' : 'regenerate';
    case 'none':
      switch (draft) {
        case 'none':
          return 'generate';
        case 'generating':
          return 'generating';
        case 'ready':
          return 'draft_ready';
        case 'held':
          // Invariant #4: no text, no affordance. The card reconstructs the
          // "Reply on hold" panel from (none, none) — held never crosses the wire.
          return 'none';
      }
  }
}

export type ProvenanceBadge =
  | 'posted_before_joining'
  | 'replied_on_google'
  | 'auto_approved'
  | 'owner_approved';

/**
 * Why RepWorth is showing a reply, so an owner never wonders where it came
 * from or why we are offering to replace it (S3). Answered rows only.
 */
export function provenanceBadge(
  r: {
    external_reply_ingested_at: string | null;
    approval_method: ApprovalMethod | null;
    review_date: string;
  },
  activatedAtIso: string | null,
): ProvenanceBadge | null {
  if (r.external_reply_ingested_at !== null) {
    // isHistorical survives ONLY as a badge input — it is no longer a
    // bucketing predicate (S3 deletes the gap/historical split).
    return isHistorical(new Date(r.review_date), activatedAtIso)
      ? 'posted_before_joining'
      : 'replied_on_google';
  }
  if (r.approval_method === APPROVAL_METHOD.AUTO_POLICY) return 'auto_approved';
  if (r.approval_method === APPROVAL_METHOD.OWNER) return 'owner_approved';
  return null;
}

/**
 * The wire shape flowing to the Reviews list surface: the card row plus the two
 * server-derived facts the card renders but must never compute (D-D, D-E).
 *
 * `response_id` widens to nullable here for the same reason it is nullable on
 * `ReviewRow` — the list now contains never-replied reviews.
 */
export interface ReviewsListRow extends Omit<PastReplyRow, 'response_id'> {
  response_id: string | null;
  row_state: ReviewRowState;
  provenance_badge: ProvenanceBadge | null;
}

/** Postgres.js may hand back a Date or a string; normalize nullable ts → ISO. */
const toIso = (d: Date | null): string | null =>
  d instanceof Date ? d.toISOString() : d == null ? null : String(d);

/**
 * Maps one row of the single row source → the wire shape the card expects.
 *
 * **Orphan rows are mapped from the `orphan_*` LATERALs, not from `resp.*`.**
 * This carries the deleted `toOrphanCardRow`'s field mapping (round-2 Defect A):
 * `PastReplyCard` renders the recovery badge from the server-derived `recover`
 * state (`PastReplyCard.tsx:314`) but still gates the recovery ACTIONS on
 * `row.failed_response_id` — `:388` in `AnsweredControls`, `:442` in
 * `RecoveryControl` — so dropping it makes recovery silently unreachable.
 * `response_id` carries the failed id too — `/retry` and `/restore-original`
 * address the failed response by id.
 * The three response-level fields (`posted_at`, `approval_method`, `version`)
 * are null because an orphan has no live posted reply.
 */
export function toCardRow(
  r: ReviewRow,
  activatedAtIso: string | null,
  hasPaidTier: boolean,
): ReviewsListRow {
  const { reply, draft } = deriveAxes(r);
  const rowState = deriveRowState(r); // transitional — deleted in #727 Task 3
  const isOrphan = reply === 'orphan';

  const reviewDateIso =
    r.review_date instanceof Date ? r.review_date.toISOString() : String(r.review_date);
  const externalReplyIngestedAt = toIso(r.external_reply_ingested_at);
  const approvalMethod = isOrphan ? null : r.approval_method;

  return {
    review_id: r.review_id,
    review_text: r.review_text,
    review_date: reviewDateIso,
    reviewer_name: r.reviewer_name,
    star_rating: r.star_rating,
    response_id: isOrphan ? r.orphan_failed_response_id : r.response_id,
    approved_text: isOrphan ? r.superseded_text ?? null : r.approved_text,
    approval_method: approvalMethod,
    posted_at: isOrphan ? null : toIso(r.posted_at),
    external_reply_ingested_at: externalReplyIngestedAt,
    review_content_hash: r.review_content_hash,
    version: isOrphan || typeof r.version !== 'number' ? null : r.version,
    // Strict paid-tier gate computed server-side.
    canEdit: canEdit(hasPaidTier),
    failed_response_id: isOrphan ? r.orphan_failed_response_id : r.failed_response_id ?? null,
    failed_posting_error: isOrphan ? r.orphan_posting_error : r.failed_posting_error ?? null,
    row_state: rowState,
    reply_state: reply,
    row_action: deriveRowAction(reply, draft),
    provenance_badge: provenanceBadge(
      {
        external_reply_ingested_at: externalReplyIngestedAt,
        approval_method: approvalMethod,
        review_date: reviewDateIso,
      },
      activatedAtIso,
    ),
  };
}

// Sort descending by review_date. String compare works: review_date is ISO-8601.
const sortByDateDesc = (a: ReviewsListRow, b: ReviewsListRow): number =>
  b.review_date.localeCompare(a.review_date);

export interface GroupedReplies {
  unansweredRows: ReviewsListRow[];
  answeredRows: ReviewsListRow[];
}

/**
 * Split one page of the row source into the `Unanswered` and `Answered` groups
 * and sort each newest-first.
 *
 * The predicate is the Posted-reply axis: `posted` is the only state with a
 * live reply on Google, so everything else — including orphan `recover` rows
 * (D-G) and held rows — groups under Unanswered. The row set is identical to
 * the pre-#727 `regenerate` grouping (pinned by test).
 * Orphans need no separate count: they have no posted sibling, so
 * `load-replies`' `NOT EXISTS` unanswered denominator already includes them.
 *
 * One row array, not two: post-F3 there is no separate orphan query to merge,
 * so there is no de-dup step either — the single row source returns each review
 * exactly once.
 */
export function groupReplies(
  rows: readonly ReviewRow[],
  activatedAtIso: string | null,
  hasPaidTier: boolean,
): GroupedReplies {
  const cards = rows.map((r) => toCardRow(r, activatedAtIso, hasPaidTier));

  return {
    unansweredRows: cards.filter((c) => c.reply_state !== 'posted').sort(sortByDateDesc),
    answeredRows: cards.filter((c) => c.reply_state === 'posted').sort(sortByDateDesc),
  };
}
