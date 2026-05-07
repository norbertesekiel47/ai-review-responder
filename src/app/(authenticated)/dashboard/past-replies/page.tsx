// src/app/(authenticated)/dashboard/past-replies/page.tsx
//
// Server component for the Past Replies tab — READ-ONLY view.
//
// Lists every review with a 'posted' response, partitioned into:
//   - "From your active period" (review_date >= subscription_activated_at).
//   - "From before you joined" (review_date < activated_at; OR all rows when
//     activated_at IS NULL).
//
// Tier-mirrored visibility: standard / founding owners see the historical
// section with a HistoricalUpgradeBanner; premium has no different
// affordances in this read-only slice (the edit feature waits for direct
// GBP API approval — see docs/runbooks/zernio-launch-runbook.md §10).
//
// 404 when PAST_REPLIES_VIEW_ENABLED is off (server-authoritative; no
// NEXT_PUBLIC_* companion).
//
// Note: The companion ingest path is gated by EXTERNAL_REPLY_IMPORT_ENABLED.
// Operators control rollout via the two flags independently — turn on
// import to start populating data silently, then turn on view to expose it.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { PastReplyCard } from '@/components/dashboard/PastReplyCard';
import { HistoricalUpgradeBanner } from '@/components/dashboard/HistoricalUpgradeBanner';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface ReviewRow {
  review_id: string;
  review_text: string | null;
  review_date: Date;
  response_id: string;
  approved_text: string | null;
  posted_at: Date | null;
  external_reply_ingested_at: Date | null;
  star_rating: number | null;
  reviewer_name: string | null;
}

export default async function PastRepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  if (process.env.PAST_REPLIES_VIEW_ENABLED !== 'true') notFound();

  const owner = await requireOwnerAccess();
  const sp = await searchParams;
  const requested = parseInt(sp.page ?? '1', 10);
  const page = Math.max(1, Number.isFinite(requested) ? requested : 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [biz] = await sql<{
    subscription_tier: string;
    subscription_activated_at: Date | null;
  }[]>`
    SELECT subscription_tier, subscription_activated_at
    FROM businesses
    WHERE id = ${owner.businessId}
    LIMIT 1
  `;
  if (!biz) notFound();

  const isPremium = biz.subscription_tier === 'premium';
  const activatedAtIso = biz.subscription_activated_at
    ? new Date(biz.subscription_activated_at).toISOString()
    : null;

  // Single paginated read of joined reviews + posted responses, newest first.
  const rows = await sql<ReviewRow[]>`
    SELECT
      r.id AS review_id,
      r.review_text,
      r.review_date,
      r.external_reply_ingested_at,
      r.star_rating,
      r.reviewer_name,
      resp.id AS response_id,
      resp.approved_text,
      resp.posted_at
    FROM reviews r
    JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
    WHERE r.business_id = ${owner.businessId}
    ORDER BY r.review_date DESC
    LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `;

  // Counts for section headings — total across the whole business, not the
  // current page. NULL-handling: when activated_at is NULL, every row lands
  // in the historical bucket (mirroring the cautious assertCanEditReply
  // stance in the parked edit feature).
  const gapCountRows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM reviews r
    JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
    WHERE r.business_id = ${owner.businessId}
      AND ${activatedAtIso}::timestamptz IS NOT NULL
      AND r.review_date >= ${activatedAtIso}::timestamptz
  `;
  const histCountRows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM reviews r
    JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
    WHERE r.business_id = ${owner.businessId}
      AND ( ${activatedAtIso}::timestamptz IS NULL
            OR r.review_date < ${activatedAtIso}::timestamptz )
  `;
  const avgRows = await sql<{ avg: number | null }[]>`
    SELECT AVG(r.star_rating)::float AS avg
    FROM reviews r
    JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
    WHERE r.business_id = ${owner.businessId}
  `;
  const avgStarRating = avgRows[0]?.avg ?? null;
  const gapTotal = gapCountRows[0]?.count ?? 0;
  const histTotal = histCountRows[0]?.count ?? 0;

  const isHistorical = (rd: Date) =>
    activatedAtIso === null || new Date(rd).getTime() < new Date(activatedAtIso).getTime();
  const gapRows = rows.filter((r) => !isHistorical(r.review_date));
  const histRows = rows.filter((r) => isHistorical(r.review_date));

  const totalRows = gapTotal + histTotal;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  const cardRow = (r: ReviewRow) => ({
    review_id: r.review_id,
    review_text: r.review_text,
    review_date: r.review_date instanceof Date ? r.review_date.toISOString() : String(r.review_date),
    reviewer_name: r.reviewer_name,
    star_rating: r.star_rating,
    response_id: r.response_id,
    approved_text: r.approved_text,
    posted_at: r.posted_at
      ? r.posted_at instanceof Date
        ? r.posted_at.toISOString()
        : String(r.posted_at)
      : null,
    external_reply_ingested_at: r.external_reply_ingested_at
      ? r.external_reply_ingested_at instanceof Date
        ? r.external_reply_ingested_at.toISOString()
        : String(r.external_reply_ingested_at)
      : null,
  });

  return (
    <div className="space-y-8 py-2">
      <header>
        <h1 className="text-2xl font-bold text-[#2a2a2a]">Past Replies</h1>
        <p className="mt-1 text-sm text-[#6a6a6a]">
          Every reply that has been posted to Google for your business — including replies you made before connecting RepWorth.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-[#2a2a2a]">
          From your active period{' '}
          <span className="text-sm font-normal text-[#6a6a6a]">({gapTotal})</span>
        </h2>
        {gapRows.length === 0 ? (
          <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-[#6a6a6a]">
            No replies on this page from your active period.
          </p>
        ) : (
          <div className="space-y-3">
            {gapRows.map((r) => (
              <PastReplyCard
                key={r.response_id}
                row={cardRow(r)}
                isImported={r.external_reply_ingested_at !== null}
              />
            ))}
          </div>
        )}
      </section>

      {histTotal > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-[#2a2a2a]">
            From before you joined{' '}
            <span className="text-sm font-normal text-[#6a6a6a]">({histTotal})</span>
          </h2>
          {!isPremium && <HistoricalUpgradeBanner />}
          {histRows.length === 0 ? (
            <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-[#6a6a6a]">
              No replies on this page from before you joined.
            </p>
          ) : (
            <div className="space-y-3">
              {histRows.map((r) => (
                <PastReplyCard
                  key={r.response_id}
                  row={cardRow(r)}
                  isImported={r.external_reply_ingested_at !== null}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {totalRows > 0 && (
        <Pagination page={page} totalPages={totalPages} />
      )}
    </div>
  );
}

function Pagination({ page, totalPages }: { page: number; totalPages: number }) {
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;
  const linkBase =
    'rounded-md border border-gray-200 px-3 py-1.5 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50';
  const disabledClasses = 'pointer-events-none opacity-40';
  return (
    <nav className="flex items-center justify-between border-t border-gray-100 pt-4">
      <Link
        href={`?page=${page - 1}`}
        aria-disabled={prevDisabled}
        tabIndex={prevDisabled ? -1 : undefined}
        className={`${linkBase} ${prevDisabled ? disabledClasses : ''}`}
      >
        ← Previous
      </Link>
      <span className="text-sm text-[#6a6a6a]">
        Page {page} of {totalPages}
      </span>
      <Link
        href={`?page=${page + 1}`}
        aria-disabled={nextDisabled}
        tabIndex={nextDisabled ? -1 : undefined}
        className={`${linkBase} ${nextDisabled ? disabledClasses : ''}`}
      >
        Next →
      </Link>
    </nav>
  );
}
