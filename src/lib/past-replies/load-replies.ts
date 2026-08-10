import type { Sql } from 'postgres';
import {
  DELETE_FAILED_PREFIX,
  POST_AFTER_DELETE_FAILED_PREFIX,
} from '@/lib/publishing/orphan-markers';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';
import { openFlagExistsSql } from '@/lib/moderation/held-draft';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { NON_TERMINAL_STATUSES } from '@/lib/shared/response-status';
import {
  peekRegenBudgetBatch,
  type RegenBudgetStatus,
} from '@/lib/costs/tracker';
import {
  PAGE_SIZE,
  groupReplies,
  type ReviewRow,
  type ReviewsListRow,
} from '@/lib/past-replies/replies-view';

/**
 * One page of the **Reviews list** — the owner's single inventory of every
 * review for a location, grouped `Unanswered` then `Answered` (#678).
 *
 * The pre-#678 gap/historical split (`gapRows` / `histRows` /
 * `hasHistoricalSection` / `hasGapOrphans`) is GONE, not deprecated: the
 * activation boundary survives only as an input to the per-row provenance badge
 * (`provenanceBadge`, `replies-view.ts`), never as a bucketing predicate. No
 * compatibility shims — pre-launch codebase, and the history page is the only
 * consumer.
 */
export interface PastRepliesPageView {
  locationDisplayName: string;
  /**
   * `ReviewsListRow`, not `PastReplyRow`: post-#727 a row carries the
   * Posted-reply axis (`reply_state`), the Action slot (`row_action`) and
   * `provenance_badge`, and its `response_id` is nullable because the
   * LEFT JOIN's `resp.id IS NULL` IS the unanswered predicate. `replies-view.ts`
   * owns the type so the card renders what the server derived rather than
   * deriving anything itself (D-D).
   */
  unansweredRows: ReviewsListRow[];
  answeredRows: ReviewsListRow[];
  /**
   * Group denominators over ALL reviews for the location — an unanswered review
   * has no posted sibling, an answered one does. Deliberately NOT posted-only:
   * `totalPages` is derived from their sum, so a posted-only denominator made
   * the tail pages of a freshly imported, mostly-unanswered location
   * unreachable.
   */
  unansweredTotal: number;
  answeredTotal: number;
  /** Mean star rating across every review for the location, replied or not. */
  avgStarRating: number | null;
  /**
   * Advisory per-review regeneration counters keyed by `review_id`, for
   * ANSWERED rows only — a first Generate is free by construction, so an
   * unanswered review has no counter to read.
   *
   * A plain RECORD, not the `Map` `peekRegenBudgetBatch` returns (D12): this
   * view crosses the server→client boundary and a `Map` does not serialize.
   * The conversion belongs at this seam.
   *
   * A MISSING key means UNKNOWN, never "0 remaining" — no counter renders and
   * the Regenerate button stays enabled (D-F). Inverting that would disable
   * every Regenerate during an Upstash outage.
   */
  regenBudgets: Record<string, RegenBudgetStatus>;
  page: number;
  totalPages: number;
}

/**
 * Loads one page of the Reviews list for a single location, scoped to
 * (accountId, locationId). Returns `null` when the location is not found / not
 * owned — the caller renders `notFound()`.
 *
 * Tenant scope (invariant #8): every query filters on the owner-resolved
 * business_id; the biz lookup additionally asserts account_id ownership. The
 * aggregating queries are allowlisted in the tenant-scope audit
 * (scripts/ci/tenant-scope-allowlist.ts).
 *
 * Invariant #15: the DB client arrives as an explicit `sql: Sql` parameter —
 * this module never imports `@/lib/db/server`; the page component is the
 * composition root that passes the singleton down.
 */
export async function loadPastRepliesPageView(
  sql: Sql,
  {
    accountId,
    locationId,
    page,
  }: {
    accountId: string;
    locationId: string;
    page: number;
  },
): Promise<PastRepliesPageView | null> {
  const offset = (page - 1) * PAGE_SIZE;

  // ── Biz display + tier/activation from accounts ───────────────────────────
  //
  // Post-migration-034 subscription_tier / subscription_activated_at live on
  // accounts (the billing parent), mirroring assertCanEditReply (edit-existing.ts)
  // which JOINs businesses → accounts to read tier + activation.
  //
  // subscription_activated_at is still read, but it no longer partitions the
  // page: it is now only the activation anchor `provenanceBadge` compares an
  // externally-ingested reply against ("Posted by you before joining" vs
  // "Replied on Google").
  const [biz] = await sql<{
    name: string;
    display_label: string | null;
    subscription_tier: string;
    subscription_activated_at: Date | null;
  }[]>`
    SELECT b.name,
           b.display_label,
           a.subscription_tier,
           a.subscription_activated_at
    FROM   businesses b
    JOIN   accounts   a ON a.id = b.account_id
    WHERE  b.id         = ${locationId}
      AND  b.account_id = ${accountId}
    LIMIT 1
  `;
  if (!biz) return null;

  const hasPaidTier = isSubscriptionTier(biz.subscription_tier);
  if (!hasPaidTier) {
    throw new Error(`invalid_ws8_subscription_tier:${biz.subscription_tier}`);
  }
  const locationDisplayName = biz.display_label ?? biz.name;
  const activatedAtIso = biz.subscription_activated_at
    ? new Date(biz.subscription_activated_at).toISOString()
    : null;

  // ── Recoverable-prefix SQL literals ───────────────────────────────────────
  //
  // Using the imported constants from orphan-markers.ts (NOT re-typed literals)
  // so a prefix change in the source-of-truth propagates here automatically.
  // Both are still needed post-F3: delete_failed_* feeds the sidecar badge on a
  // healthy posted reply, post_after_delete_failed_* feeds the orphan LATERAL.
  const deletePfx = `${DELETE_FAILED_PREFIX}%`;
  const postAfterPfx = `${POST_AFTER_DELETE_FAILED_PREFIX}%`;

  // ── Main data load ─────────────────────────────────────────────────────────
  //
  // FOUR queries, not five. The separate orphan query this file used to run was
  // deleted at #678 (F3): it de-duplicated against the main query purely because
  // the main query INNER JOINed `posted`. Under the LEFT JOIN below the main
  // query returns EVERY review, so an orphan review would have matched both — it
  // would render twice (once `generate`, once `recover`) and its un-offset
  // `LIMIT 50` would merge into every page. Its two LATERALs moved in here
  // instead (orphan_sidecar, orphan_superseded), which also turns `is_orphan`
  // into a column on the single row source rather than caller discipline.
  //
  // Consequence, and it is the correct one: orphan cards are now inside the
  // LIMIT/OFFSET window and inside unansweredTotal (they have no posted sibling,
  // so the NOT EXISTS count already includes them), i.e. paginated like every
  // other row instead of repeating on every page.
  const [rows, unansweredCountRows, answeredCountRows, avgRows] = await Promise.all([
    // The SINGLE row source for the page:
    //   - review_content_hash + version for the optimistic-concurrency snapshot
    //   - the `resp` LEFT JOIN: the live posted reply, or NULL — this is what
    //     makes a row Answered vs Unanswered, and what the ORDER BY sorts on
    //     first
    //   - four LATERAL sidecars, each de-duped to at most one row per review
    sql<ReviewRow[]>`
      SELECT
        r.id                            AS review_id,
        r.review_text,
        r.review_date,
        r.review_content_hash,
        r.external_reply_ingested_at,
        r.star_rating,
        r.reviewer_name,
        resp.id                         AS response_id,
        resp.approved_text,
        resp.approval_method,
        resp.posted_at,
        resp.version,
        fail_sidecar.id                 AS failed_response_id,
        fail_sidecar.posting_error      AS failed_posting_error,
        draft.id                        AS draft_response_id,
        COALESCE(draft.held, false)     AS draft_held,
        (pending_gen.exists IS NOT NULL) AS generation_in_flight,
        -- F3: orphan-ness is DATA, not caller discipline. An orphan is a
        -- post_after_delete_failed_* sibling with NO live posted sibling; the
        -- resp.id IS NULL conjunct is exactly what the deleted query's
        -- NOT EXISTS clause used to guarantee.
        (orphan_sidecar.id IS NOT NULL AND resp.id IS NULL) AS is_orphan,
        orphan_sidecar.id               AS orphan_failed_response_id,
        orphan_sidecar.posting_error    AS orphan_posting_error,
        orphan_superseded.approved_text AS superseded_text
      FROM reviews r
      -- LEFT, not INNER: the Reviews list is every review for the location, not
      -- only the replied ones. resp.id IS NULL IS the unanswered predicate.
      LEFT JOIN responses resp
        ON resp.review_id = r.id
       AND resp.status = 'posted'
      -- LATERAL sidecar: most-recent delete_failed_* failed sibling for this review.
      -- Scope is delete_failed_* ONLY — those are the failures whose live 'posted'
      -- reply is still on Google and genuinely needs attention. A
      -- post_after_delete_failed_* row that coexists with a live 'posted' row is a
      -- RESOLVED/stale orphan marker (e.g. /restore-original already republished),
      -- so attaching it here would badge a healthy reply while /retry + /restore
      -- reject with live_reply_exists. Genuine orphans (post_after_delete_failed_*
      -- with NO posted sibling) arrive via orphan_sidecar below instead.
      -- ORDER BY created_at DESC + LIMIT 1 attaches only the newest failure.
      LEFT JOIN LATERAL (
        SELECT id, posting_error
        FROM responses
        WHERE review_id = r.id
          AND status = 'failed' -- review-status-ignore: responses.status, not reviews.status (unqualified inside this nested FROM-responses subquery — the reviews-status guard's coarse regex flags any unqualified status literal in a template that also mentions reviews elsewhere)
          AND posting_error LIKE ${deletePfx}
        ORDER BY created_at DESC
        LIMIT 1
      ) fail_sidecar ON true
      -- NEW (#678): the live NON-TERMINAL response, which makes the row read
      -- Draft ready and never offer Generate (S2). The partial unique index
      -- (migrations 023+026+029) permits at most ONE non-terminal response per
      -- review, so the ORDER BY/LIMIT is belt-and-braces, not a real tie-break.
      --
      -- Invariant #4: the held flag is CARRIED, not filtered. Excluding a held
      -- draft here would leave draft_response_id NULL, deriveAxes would read
      -- the Replacement-draft axis as absent, and deriveRowAction would project
      -- a Generate affordance — offering an LLM spend that the partial unique
      -- index would then reject. Selected, the axis resolves to held and the
      -- Action slot projects 'none' — the withdrawn slot — instead (D9).
      --
      -- src/lib/moderation/held-draft.ts is the SEMANTIC owner of "a draft is
      -- held while an open flagged_responses row exists"; this projection
      -- composes its openFlagExistsSql fragment (#730). Projected, not
      -- filtered (D9): a held draft must stay distinguishable from "no draft".
      LEFT JOIN LATERAL (
        SELECT
          resp2.id,
          ${openFlagExistsSql(sql, sql`resp2.id`)} AS held
        FROM responses resp2
        WHERE resp2.review_id = r.id
          AND resp2.status = ANY(${[...NON_TERMINAL_STATUSES] as string[]}::text[])
        ORDER BY resp2.version DESC
        LIMIT 1
      ) draft ON true
      -- NEW (#678): an in-flight generate_response outbox row, which makes the
      -- row read Generating. Server-rendered, so the state survives a page
      -- refresh (D-C); without it a refresh would re-offer Generate and burn a
      -- rate-limit token to learn it 409s.
      --
      -- The in-flight set is the byte-for-byte contract owned by
      -- src/lib/shared/job-outbox-status.ts (invariant #2) — re-spelled by hand
      -- exactly as every other site does, because a bind parameter inside an
      -- ON CONFLICT ... WHERE predicate defeats partial-index inference.
      -- ci:outbox-status checks members AND order.
      LEFT JOIN LATERAL (
        SELECT 1 AS exists
        FROM job_outbox
        WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE}
          AND aggregate_id = r.id
          AND status IN ('pending', 'dispatching', 'dispatched')
        LIMIT 1
      ) pending_gen ON true
      -- NEW (#678, F3): the deleted orphan query's inner JOIN LATERAL, folded in
      -- as a LEFT join so this query still returns non-orphan reviews.
      -- Most-recent post_after_delete_failed_* failed response for the review —
      -- the DELETE succeeded but the re-POST did not, so there is no live Google
      -- reply and the owner needs /retry or /restore-original.
      LEFT JOIN LATERAL (
        SELECT id, posting_error
        FROM responses
        WHERE review_id = r.id
          AND status = 'failed' -- review-status-ignore: responses.status, not reviews.status (unqualified inside this nested FROM-responses subquery — the reviews-status guard's coarse regex flags any unqualified status literal in a template that also mentions reviews elsewhere)
          AND posting_error LIKE ${postAfterPfx}
        ORDER BY created_at DESC
        LIMIT 1
      ) orphan_sidecar ON true
      -- NEW (#678, F3): most-recent superseded sibling for the recovery drawer's
      -- "original" pane (the text the owner approved before the failed edit). No
      -- other LATERAL carries it, and the recovery UI is unreachable without it.
      LEFT JOIN LATERAL (
        SELECT COALESCE(approved_text, response_text) AS approved_text
        FROM responses
        WHERE review_id = r.id
          AND status = 'superseded' -- review-status-ignore: responses.status, not reviews.status (unqualified inside this nested FROM-responses subquery; 'superseded' is not itself in the REVIEW_STATUS vocabulary today, and the pragma stays so a future vocabulary change cannot silently turn this line into a finding)
        ORDER BY created_at DESC
        LIMIT 1
      ) orphan_superseded ON true
      WHERE r.business_id = ${locationId}
      -- Unanswered first (S6): false sorts before true in Postgres, so
      -- (resp.id IS NOT NULL) puts the never-replied group at the top, then
      -- newest-first inside each group. The r.id DESC tie-breaker is NOT
      -- optional: without a total order two reviews sharing a review_date can
      -- swap across an OFFSET boundary, so one row is shown twice and another
      -- never at all (F7).
      ORDER BY (resp.id IS NOT NULL), r.review_date DESC, r.id DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `,

    // Group denominators. These replace the activation-split gap/historical
    // COUNTs: the split is no longer a section boundary (S3 → per-row provenance
    // badges), and both counts now span every review for the location rather
    // than only posted ones. Orphan rows need no separate term — they have no
    // posted sibling, so the unanswered count already includes them.
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM reviews r
      WHERE r.business_id = ${locationId}
        AND NOT EXISTS (
          SELECT 1
          FROM responses p
          WHERE p.review_id = r.id
            AND p.status = 'posted'
        )
    `,
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM reviews r
      WHERE r.business_id = ${locationId}
        AND EXISTS (
          SELECT 1
          FROM responses p
          WHERE p.review_id = r.id
            AND p.status = 'posted'
        )
    `,
    // Mean star rating over ALL reviews for the location. The pre-#678 query
    // JOINed posted responses, which answered a different question ("how do the
    // reviews you replied to rate?") than the tile asks.
    sql<{ avg: number | null }[]>`
      SELECT AVG(r.star_rating)::float AS avg
      FROM reviews r
      WHERE r.business_id = ${locationId}
    `,
  ]);

  const unansweredTotal = unansweredCountRows[0]?.count ?? 0;
  const answeredTotal = answeredCountRows[0]?.count ?? 0;
  const avgStarRating = avgRows[0]?.avg ?? null;

  const { unansweredRows, answeredRows } = groupReplies(rows, activatedAtIso, hasPaidTier);

  // ── Advisory regen-budget counters (D-F) ──────────────────────────────────
  //
  // ONE batched MGET, and only over the ANSWERED rows: a first Generate on a
  // never-replied review is free by construction (the door charges only
  // version > 1), so an unanswered review has no counter to read.
  //
  // NO catch here, deliberately. peekRegenBudgetBatch has no rejection path: it
  // calls getCacheRedis() inside its own try, so a transport failure AND a
  // synchronous client-construction throw both resolve to an EMPTY map and are
  // logged there on the shared `regen_budget_peek_failed` stream. An empty map
  // means no counter renders and every Regenerate stays enabled. The
  // authoritative gate is unaffected: it is the worker's Lua INCR
  // (checkRegenBudget), which still refuses over-budget work before any spend.
  const regenBudgetMap: Map<string, RegenBudgetStatus> = await peekRegenBudgetBatch(
    answeredRows.map((r: ReviewsListRow) => r.review_id),
  );

  return {
    locationDisplayName,
    unansweredRows,
    answeredRows,
    unansweredTotal,
    answeredTotal,
    avgStarRating,
    // Map → Record at the seam (D12): the client prop is a plain record.
    regenBudgets: Object.fromEntries(regenBudgetMap),
    page,
    // A TRUE denominator over all reviews, so the tail pages of a fresh Review
    // import are reachable (#671 landmine 3).
    totalPages: Math.max(1, Math.ceil((unansweredTotal + answeredTotal) / PAGE_SIZE)),
  };
}
