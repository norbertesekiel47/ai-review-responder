import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { PastRepliesClient } from './PastRepliesClient';
import { getDisplayLabel } from '@/lib/locations/display-label';
import {
  DELETE_FAILED_PREFIX,
  POST_AFTER_DELETE_FAILED_PREFIX,
} from '../../../../../worker/jobs/publisher/orphan-markers';
import type { ApprovalMethod } from '@/lib/auto-approval/types';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

// Sort descending by review_date. Sorting strings works because review_date is an
// ISO-8601 string after toISOString().
const sortByDateDesc = (a: { review_date: string }, b: { review_date: string }) =>
  b.review_date.localeCompare(a.review_date);

interface ReviewRow {
  review_id: string;
  review_text: string | null;
  review_date: Date;
  response_id: string;
  approved_text: string | null;
  approval_method: ApprovalMethod | null;
  posted_at: Date | null;
  external_reply_ingested_at: Date | null;
  star_rating: number | null;
  reviewer_name: string | null;
  // Optimistic-concurrency snapshot fields.
  review_content_hash: string | null;
  version: number | null;
  // Failed-sibling sidecar from the LATERAL join.
  failed_response_id: string | null;
  failed_posting_error: string | null;
}

// Shape returned by the orphan-only query (reviews with a post_after_delete_failed_*
// failed response and NO posted sibling). These surface as their own recovery cards.
interface OrphanRow {
  review_id: string;
  review_text: string | null;
  review_date: Date;
  star_rating: number | null;
  reviewer_name: string | null;
  review_content_hash: string | null;
  // The failed response is the primary identifier for orphan rows.
  failed_response_id: string;
  failed_posting_error: string;
  // The most-recent superseded sibling's text (for drawer context). May be null.
  superseded_text: string | null;
}

// Maps an orphan-only row (no posted sibling) into the same PastReplyRow wire
// shape the card expects, using the failed response's id as response_id so
// PastRepliesClient's key prop stays unique. Fields that require a posted row
// (posted_at, external_reply_ingested_at, version) are null — the card already
// guards all of them. approved_text carries the superseded sibling's text (if
// any) so the drawer can show it as context; the card falls back gracefully when
// null. canEdit is always true for orphan rows: the owner already approved and
// attempted this edit, so recovery affordances must not be gated by the C-2
// lock (the recovery branch takes precedence over the lock badge in the card).
const orphanCardRow = (r: OrphanRow) => ({
  review_id: r.review_id,
  review_text: r.review_text,
  review_date:
    r.review_date instanceof Date ? r.review_date.toISOString() : String(r.review_date),
  reviewer_name: r.reviewer_name,
  star_rating: r.star_rating,
  // Use the failed response's id so the card/drawer can look it up.
  response_id: r.failed_response_id,
  approved_text: r.superseded_text ?? null,
  approval_method: null,
  posted_at: null,
  external_reply_ingested_at: null,
  review_content_hash: r.review_content_hash,
  version: null,
  // Always canEdit so the recovery button is never replaced by the premium lock.
  canEdit: true,
  failed_response_id: r.failed_response_id,
  failed_posting_error: r.failed_posting_error,
});

// pre-existing; component split tracked separately.
// react-doctor-disable-next-line react-doctor/no-giant-component
export default async function PastRepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  if (process.env.PAST_REPLIES_VIEW_ENABLED !== 'true') notFound();

  // Flag: edit affordances are only shown when both flags are on.
  // Computed server-side (same formula as layout.tsx nav-only plumbing) and
  // passed to the client so the page itself is the canonical gate.
  const editRepliesEnabled =
    process.env.PAST_REPLIES_VIEW_ENABLED === 'true' &&
    process.env.EDIT_REPLIES_ENABLED === 'true';

  const owner = await requireOwnerAccess();
  const sp = await searchParams;
  const requested = parseInt(sp.page ?? '1', 10);
  const page = Math.max(1, Number.isFinite(requested) ? requested : 1);
  const offset = (page - 1) * PAGE_SIZE;

  const locationId = owner.currentLocationId;
  const accountId = owner.accountId;

  // ── Biz display + tier/activation from accounts (latent-bug fix) ──────────
  //
  // Pre-migration-034 this read subscription_tier / subscription_activated_at
  // from businesses. Post-034 those columns live on accounts (the billing
  // parent). Mirroring assertCanEditReply (edit-existing.ts) which JOINs
  // businesses → accounts to read tier + activation.
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
  if (!biz) notFound();

  const locationDisplayName = biz.display_label ?? biz.name;
  const isPremium = biz.subscription_tier === 'premium';
  const activatedAtIso = biz.subscription_activated_at
    ? new Date(biz.subscription_activated_at).toISOString()
    : null;

  // ── C-2 rule (mirrors assertCanEditReply exactly) ─────────────────────────
  //
  //   isHistorical = activated_at IS NULL OR review_date < activated_at
  //   canEdit      = NOT isHistorical OR isPremium
  //
  // Boundary: review_date == subscription_activated_at → gap (>= predicate).
  const isHistoricalFn = (rd: Date) =>
    activatedAtIso === null ||
    new Date(rd).getTime() < new Date(activatedAtIso).getTime();

  const canEditFn = (rd: Date) => {
    const historical = isHistoricalFn(rd);
    return !historical || isPremium;
  };

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
          AND status = 'failed'
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
          AND status = 'failed'
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
          AND status = 'superseded'
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

  const cardRow = (r: ReviewRow) => ({
    review_id: r.review_id,
    review_text: r.review_text,
    review_date:
      r.review_date instanceof Date ? r.review_date.toISOString() : String(r.review_date),
    reviewer_name: r.reviewer_name,
    star_rating: r.star_rating,
    response_id: r.response_id,
    approved_text: r.approved_text,
    approval_method: r.approval_method,
    posted_at:
      r.posted_at instanceof Date
        ? r.posted_at.toISOString()
        : r.posted_at == null
          ? null
          : String(r.posted_at),
    external_reply_ingested_at:
      r.external_reply_ingested_at instanceof Date
        ? r.external_reply_ingested_at.toISOString()
        : r.external_reply_ingested_at == null
          ? null
          : String(r.external_reply_ingested_at),
    // Snapshot fields for EditReplyDrawer.
    review_content_hash: r.review_content_hash,
    version: typeof r.version === 'number' ? r.version : null,
    // C-2 gate computed server-side.
    canEdit: canEditFn(
      r.review_date instanceof Date ? r.review_date : new Date(r.review_date),
    ),
    // Recoverable failed sibling (null when no recoverable failure exists).
    failed_response_id: r.failed_response_id ?? null,
    failed_posting_error: r.failed_posting_error ?? null,
  });

  // Bucket posted rows by date in a single pass (filter + map collapsed).
  const postedGapRows = rows.flatMap((r) =>
    !isHistoricalFn(r.review_date) ? [cardRow(r)] : [],
  );
  const postedHistRows = rows.flatMap((r) =>
    isHistoricalFn(r.review_date) ? [cardRow(r)] : [],
  );

  // Bucket orphan rows using the same gap/historical predicate, then merge into
  // each bucket. De-dup is structural: the orphan query's NOT EXISTS clause
  // guarantees no review_id overlap with the posted query. Filter + map collapsed
  // into a single pass.
  const orphanGapRows = orphanRows.flatMap((r) =>
    !isHistoricalFn(r.review_date) ? [orphanCardRow(r)] : [],
  );
  const orphanHistRows = orphanRows.flatMap((r) =>
    isHistoricalFn(r.review_date) ? [orphanCardRow(r)] : [],
  );

  const gapRows = [...postedGapRows, ...orphanGapRows].sort(sortByDateDesc);
  const histRows = [...postedHistRows, ...orphanHistRows].sort(sortByDateDesc);

  const totalRows = gapTotal + histTotal;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  return (
    <>
      <TopBar
        title="Past Replies"
        subtitle={`Every reply posted to Google for ${locationDisplayName} — including replies you made before connecting RepWorth.`}
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <PastRepliesClient
        gapRows={gapRows}
        histRows={histRows}
        gapTotal={gapTotal}
        histTotal={histTotal}
        // Include orphan rows in section visibility: an orphan hist/gap row has no
        // posted sibling (histTotal/gapTotal won't count it), but the owner still
        // needs to see the recovery card. Gate on posted count OR orphan count.
        hasHistoricalSection={histTotal > 0 || orphanHistRows.length > 0}
        hasGapOrphans={orphanGapRows.length > 0}
        avgStarRating={avgStarRating}
        isPremium={isPremium}
        page={page}
        totalPages={totalPages}
        editRepliesEnabled={editRepliesEnabled}
      />
    </>
  );
}
