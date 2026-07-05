import type { Sql } from 'postgres';
import {
  DELETE_FAILED_PREFIX,
  POST_AFTER_DELETE_FAILED_PREFIX,
} from '@/lib/publishing/orphan-markers';
import type { PastReplyRow } from '@/components/dashboard/reviews/PastReplyCard';
import {
  PAGE_SIZE,
  bucketReplies,
  type OrphanRow,
  type ReviewRow,
} from '@/lib/past-replies/replies-view';

export interface PastRepliesPageView {
  locationDisplayName: string;
  isPremium: boolean;
  gapRows: PastReplyRow[];
  histRows: PastReplyRow[];
  /** Posted-only counts (orphan rows are excluded; they are failures, not posts). */
  gapTotal: number;
  histTotal: number;
  avgStarRating: number | null;
  hasHistoricalSection: boolean;
  hasGapOrphans: boolean;
  page: number;
  totalPages: number;
}

/**
 * Loads one page of the Past Replies archive for a single location, scoped to
 * (accountId, locationId). Returns `null` when the location is not found / not
 * owned — the caller renders `notFound()`.
 *
 * Tenant scope: every query filters on the owner-resolved business_id; the biz
 * lookup additionally asserts account_id ownership. The aggregating queries are
 * allowlisted in the tenant-scope audit (scripts/ci/tenant-scope-allowlist.ts).
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

  const locationDisplayName = biz.display_label ?? biz.name;
  const isPremium = biz.subscription_tier === 'premium';
  const activatedAtIso = biz.subscription_activated_at
    ? new Date(biz.subscription_activated_at).toISOString()
    : null;

  // ── Recoverable-prefix SQL literals ───────────────────────────────────────
  //
  // Using the imported constants from orphan-markers.ts (NOT re-typed literals)
  // so a prefix change in the source-of-truth propagates here automatically.
  const deletePfx = `${DELETE_FAILED_PREFIX}%`;
  const postAfterPfx = `${POST_AFTER_DELETE_FAILED_PREFIX}%`;

  // ── Main data load ─────────────────────────────────────────────────────────
  const [rows, orphanRows, gapCountRows, histCountRows, avgRows] = await Promise.all([
    // Page of posted rows with:
    //   - review_content_hash + version for the optimistic-concurrency snapshot
    //   - LATERAL sidecar of the most-recent recoverable failed sibling per review
    //     (de-duped by review: a delete_failed_* row coexists with a live posted
    //     row → attach to the posted card, don't render twice; an orphan-only
    //     post_after_delete_failed_* row has no posted sibling and is excluded from
    //     this query — it surfaces via the orphanRows query below instead).
    sql<ReviewRow[]>`
      SELECT
        r.id                           AS review_id,
        r.review_text,
        r.review_date,
        r.review_content_hash,
        r.external_reply_ingested_at,
        r.star_rating,
        r.reviewer_name,
        resp.id                        AS response_id,
        resp.approved_text,
        resp.approval_method,
        resp.posted_at,
        resp.version,
        fail_sidecar.id                AS failed_response_id,
        fail_sidecar.posting_error     AS failed_posting_error
      FROM reviews r
      JOIN responses resp
        ON resp.review_id = r.id
       AND resp.status = 'posted'
      -- LATERAL sidecar: most-recent delete_failed_* failed sibling for this review.
      -- Scope is delete_failed_* ONLY — those are the failures whose live 'posted'
      -- reply is still on Google and genuinely needs attention. A
      -- post_after_delete_failed_* row that coexists with a live 'posted' row is a
      -- RESOLVED/stale orphan marker (e.g. /restore-original already republished),
      -- so attaching it here would badge a healthy reply while /retry + /restore
      -- reject with live_reply_exists. Genuine orphans (post_after_delete_failed_*
      -- with NO posted sibling) surface via the orphanRows query below instead.
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
      WHERE r.business_id = ${locationId}
      ORDER BY r.review_date DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `,

    // Orphan-only recovery rows: reviews where DELETE succeeded but POST failed
    // (post_after_delete_failed_* prefix) and NO posted sibling exists. These
    // have no live Google reply, so they cannot appear via the posted JOIN above;
    // they need their own card so the owner can reach /retry or /restore-original.
    //
    // De-dup guarantee: a review with a posted sibling is excluded by the
    // NOT EXISTS clause, so there is zero overlap with the posted-rows query.
    //
    // Count policy: the stats counters (gapTotal, histTotal, avgStarRating) count
    // posted replies only. Orphan cards appear in the visual list but do not
    // inflate the stat tiles or pagination denominator — they are failures, not
    // successfully posted replies. This is consistent and avoids confusion.
    //
    // Pagination: orphan rows are not offset-paginated separately — they are a
    // small, bounded set (one per review that has ever orphaned without recovery).
    // They are merged into whichever bucket their review_date falls into alongside
    // the current page of posted rows. On large accounts with many orphans this
    // could exceed PAGE_SIZE; that edge case is acceptable for now (orphans are
    // rare, and recovery resolves them).
    sql<OrphanRow[]>`
      SELECT
        r.id                           AS review_id,
        r.review_text,
        r.review_date,
        r.review_content_hash,
        r.star_rating,
        r.reviewer_name,
        fail_resp.id                   AS failed_response_id,
        fail_resp.posting_error        AS failed_posting_error,
        superseded.approved_text       AS superseded_text
      FROM reviews r
      -- Most-recent post_after_delete_failed_* failed response for this review.
      JOIN LATERAL (
        SELECT id, posting_error
        FROM responses
        WHERE review_id = r.id
          AND status = 'failed' -- review-status-ignore: responses.status, not reviews.status (unqualified inside this nested FROM-responses subquery — the reviews-status guard's coarse regex flags any unqualified status literal in a template that also mentions reviews elsewhere)
          AND posting_error LIKE ${postAfterPfx}
        ORDER BY created_at DESC
        LIMIT 1
      ) fail_resp ON true
      -- Most-recent superseded sibling for drawer context (the text the owner
      -- approved before the failed edit; shown as "original" in the recovery UI).
      LEFT JOIN LATERAL (
        SELECT COALESCE(approved_text, response_text) AS approved_text
        FROM responses
        WHERE review_id = r.id
          AND status = 'superseded' -- review-status-ignore: responses.status, not reviews.status (unqualified; the guard's lazy cross-line scan also attributes this line to the later posted_check.status = 'posted' match a few lines down, which is likewise responses.status)
        ORDER BY created_at DESC
        LIMIT 1
      ) superseded ON true
      WHERE r.business_id = ${locationId}
        -- Exclude reviews that already have a live posted sibling — those are
        -- handled by the delete_failed_* LATERAL sidecar on the posted-rows query.
        AND NOT EXISTS (
          SELECT 1
          FROM responses posted_check
          WHERE posted_check.review_id = r.id
            AND posted_check.status = 'posted'
        )
      ORDER BY r.review_date DESC
    `,

    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM reviews r
      JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
      WHERE r.business_id = ${locationId}
        AND ${activatedAtIso}::timestamptz IS NOT NULL
        AND r.review_date >= ${activatedAtIso}::timestamptz
    `,
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM reviews r
      JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
      WHERE r.business_id = ${locationId}
        AND ( ${activatedAtIso}::timestamptz IS NULL
              OR r.review_date < ${activatedAtIso}::timestamptz )
    `,
    sql<{ avg: number | null }[]>`
      SELECT AVG(r.star_rating)::float AS avg
      FROM reviews r
      JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
      WHERE r.business_id = ${locationId}
    `,
  ]);

  const gapTotal = gapCountRows[0]?.count ?? 0;
  const histTotal = histCountRows[0]?.count ?? 0;
  const avgStarRating = avgRows[0]?.avg ?? null;

  const { gapRows, histRows, orphanGapCount, orphanHistCount } = bucketReplies(
    rows,
    orphanRows,
    activatedAtIso,
    isPremium,
  );

  return {
    locationDisplayName,
    isPremium,
    gapRows,
    histRows,
    gapTotal,
    histTotal,
    avgStarRating,
    // Orphan rows have no posted sibling (the *Total counts won't include them),
    // but the owner still needs to see the recovery card — gate section
    // visibility on posted count OR orphan presence.
    hasHistoricalSection: histTotal > 0 || orphanHistCount > 0,
    hasGapOrphans: orphanGapCount > 0,
    page,
    totalPages: Math.max(1, Math.ceil((gapTotal + histTotal) / PAGE_SIZE)),
  };
}
