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
 * the unanswered predicate, and `deriveAxes` depends on that fact. Do not
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
 * Unanswered/Answered, which the Posted-reply axis (`deriveAxes`) decides.
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

/**
 * The single row source's facts → the two axes.
 *
 * Still-true precedence carried from the deleted pre-#727 single enum: `held`
 * is tested on the SAME branch as `ready` (invariant #4 / D9), so a held draft
 * can never read as an absent one and project a Generate affordance — an LLM
 * spend the partial unique index (migrations 023+026+029) would then reject;
 * and a live draft outranks an in-flight outbox row because the response row
 * is the settled fact.
 */
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
      // recovery drawer could reach. Dominance is about the AFFORDANCE:
      // executing /retry or /restore-original while any non-terminal sibling
      // exists — a held draft included — 409s `newer_draft_exists`
      // (migration-029 index protection); for a held sibling that wait is
      // admin-controlled. Charted producers of orphan×held are closed
      // (`on-demand-generate` refuses orphans).
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
 * The wire shape flowing to the Reviews list surface: the card row plus the
 * server-derived provenance badge the card renders but must never compute
 * (D-D, D-E). The two axes' wire projection (`reply_state`, `row_action`)
 * lives on `PastReplyRow` itself.
 *
 * `response_id` widens to nullable here for the same reason it is nullable on
 * `ReviewRow` — the list now contains never-replied reviews.
 */
export interface ReviewsListRow extends Omit<PastReplyRow, 'response_id'> {
  response_id: string | null;
  provenance_badge: ProvenanceBadge | null;
}

/** Postgres.js may hand back a Date or a string; normalize nullable ts → ISO. */
const toIso = (d: Date | null): string | null =>
  d instanceof Date ? d.toISOString() : d == null ? null : String(d);

/**
 * The seven fields whose SOURCE is decided entirely by the Posted-reply axis:
 * an orphan reads them from the `orphan_*` LATERALs, every other row from
 * `resp.*` + `fail_sidecar`. Everything else on the card is axis-independent.
 *
 * `Required<>` is load-bearing, not decoration. `version`,
 * `failed_response_id` and `failed_posting_error` are OPTIONAL on
 * `PastReplyRow` (`PastReplyCard.tsx:51,55,56`), so a bare `Pick<>` would let
 * either mapper silently omit one — which is exactly how #678's round-2
 * Defect A happened: the deleted `toOrphanCardRow` dropped
 * `failed_response_id`, and because `AnsweredControls` and `RecoveryControl`
 * gate the recovery ACTIONS on that field (not on the badge), recovery went
 * silently unreachable. Stripping the `?` makes the omission a compile error
 * — TS2741 for one omitted field, TS2739 for several — rather than something a
 * reviewer has to catch. Verified, not assumed: deleting the
 * `failed_response_id` line here reports `TS2741` at this mapper's `return {`.
 * That type — not vigilance — is what makes re-splitting the function safe
 * this time.
 */
type ReplyFacts = Required<
  Pick<
    ReviewsListRow,
    | 'response_id'
    | 'approved_text'
    | 'approval_method'
    | 'posted_at'
    | 'version'
    | 'failed_response_id'
    | 'failed_posting_error'
  >
>;

/**
 * Orphan reply facts — mapped from the `orphan_*` LATERALs, never from `resp.*`.
 *
 * `response_id` carries the FAILED id because `/retry` and `/restore-original`
 * address the failed response by id, and `failed_response_id` carries it too
 * because the card gates the recovery actions on that field specifically.
 * The three response-level fields are null: an orphan has no live posted reply,
 * so there is no posting time, no approval provenance and no
 * optimistic-concurrency version to hand out.
 */
function orphanReplyFacts(r: ReviewRow): ReplyFacts {
  return {
    response_id: r.orphan_failed_response_id,
    approved_text: r.superseded_text ?? null,
    approval_method: null,
    posted_at: null,
    version: null,
    failed_response_id: r.orphan_failed_response_id,
    failed_posting_error: r.orphan_posting_error,
  };
}

/**
 * Live reply facts — `posted` and `none` alike, so there is no third mapper.
 *
 * `response_id` is null for a never-replied review because the `resp` join is
 * LEFT, and that null IS the unanswered predicate. The failed_* pair comes from
 * `fail_sidecar` — the `delete_failed_*` sibling of a reply that is STILL live
 * on Google — which is a different fact from an orphan marker and must not be
 * conflated with one.
 */
function liveReplyFacts(r: ReviewRow): ReplyFacts {
  return {
    response_id: r.response_id,
    approved_text: r.approved_text,
    approval_method: r.approval_method,
    posted_at: toIso(r.posted_at),
    // Postgres.js can hand back a non-number here; the guard is carried
    // verbatim from the pre-#731 `typeof r.version !== 'number'` ternary.
    version: typeof r.version === 'number' ? r.version : null,
    failed_response_id: r.failed_response_id ?? null,
    failed_posting_error: r.failed_posting_error ?? null,
  };
}

/**
 * Maps one row of the single row source → the wire shape the card expects.
 *
 * **Orphan rows are mapped from the `orphan_*` LATERALs, not from `resp.*`.**
 * The field mapping is owned by two private mappers dispatched on the
 * Posted-reply axis — `orphanReplyFacts` / `liveReplyFacts` — which replaced
 * seven `isOrphan ? … : …` ternaries at #731. The dispatch happens ONCE; see
 * `ReplyFacts` for why the split is safe now when #678's round-2 Defect A says
 * it was not before.
 *
 * The mappers are deliberately NOT exported: they are an internal seam, and
 * every test reaches them through `toCardRow`. Testing them directly would pin
 * the refactor's shape instead of the card's behaviour.
 */
export function toCardRow(
  r: ReviewRow,
  activatedAtIso: string | null,
  hasPaidTier: boolean,
): ReviewsListRow {
  const { reply, draft } = deriveAxes(r);

  const reviewDateIso =
    r.review_date instanceof Date ? r.review_date.toISOString() : String(r.review_date);
  const externalReplyIngestedAt = toIso(r.external_reply_ingested_at);
  // The ONE dispatch on the Posted-reply axis. `none` and `posted` share a
  // mapper because they read the same columns — the difference between them is
  // whether the LEFT JOIN found a row, which `liveReplyFacts` passes through.
  const facts = reply === 'orphan' ? orphanReplyFacts(r) : liveReplyFacts(r);

  return {
    review_id: r.review_id,
    review_text: r.review_text,
    review_date: reviewDateIso,
    reviewer_name: r.reviewer_name,
    star_rating: r.star_rating,
    external_reply_ingested_at: externalReplyIngestedAt,
    review_content_hash: r.review_content_hash,
    // Strict paid-tier gate computed server-side.
    canEdit: canEdit(hasPaidTier),
    ...facts,
    reply_state: reply,
    row_action: deriveRowAction(reply, draft),
    provenance_badge: provenanceBadge(
      {
        external_reply_ingested_at: externalReplyIngestedAt,
        // The DISPATCHED approval_method, not `r.approval_method`: reading the
        // raw row would badge an orphan `auto_approved`/`owner_approved` for a
        // reply that is not on Google at all.
        approval_method: facts.approval_method,
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
