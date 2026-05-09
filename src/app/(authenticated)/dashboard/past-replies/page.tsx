import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/TopBar';
import { PastRepliesClient } from './PastRepliesClient';
import { getDisplayLabel } from '@/lib/locations/display-label';

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

  const locationId = owner.currentLocationId;

  const [biz] = await sql<{
    name: string;
    display_label: string | null;
    subscription_tier: string;
    subscription_activated_at: Date | null;
  }[]>`
    SELECT name, display_label, subscription_tier, subscription_activated_at
    FROM businesses
    WHERE id = ${locationId}
    LIMIT 1
  `;
  if (!biz) notFound();

  // Use display_label (with name fallback) for the subtitle
  const locationDisplayName = biz.display_label ?? biz.name;
  const isPremium = biz.subscription_tier === 'premium';
  const activatedAtIso = biz.subscription_activated_at
    ? new Date(biz.subscription_activated_at).toISOString()
    : null;

  // Four independent reads — fire in parallel.
  const [rows, gapCountRows, histCountRows, avgRows] = await Promise.all([
    sql<ReviewRow[]>`
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
      WHERE r.business_id = ${locationId}
      ORDER BY r.review_date DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
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

  const isHistorical = (rd: Date) =>
    activatedAtIso === null || new Date(rd).getTime() < new Date(activatedAtIso).getTime();

  const cardRow = (r: ReviewRow) => ({
    review_id: r.review_id,
    review_text: r.review_text,
    review_date: r.review_date instanceof Date ? r.review_date.toISOString() : String(r.review_date),
    reviewer_name: r.reviewer_name,
    star_rating: r.star_rating,
    response_id: r.response_id,
    approved_text: r.approved_text,
    posted_at:
      r.posted_at instanceof Date ? r.posted_at.toISOString() : r.posted_at == null ? null : String(r.posted_at),
    external_reply_ingested_at:
      r.external_reply_ingested_at instanceof Date
        ? r.external_reply_ingested_at.toISOString()
        : r.external_reply_ingested_at == null
        ? null
        : String(r.external_reply_ingested_at),
  });

  const gapRows = rows.filter((r) => !isHistorical(r.review_date)).map(cardRow);
  const histRows = rows.filter((r) => isHistorical(r.review_date)).map(cardRow);

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
        avgStarRating={avgStarRating}
        isPremium={isPremium}
        hasHistoricalSection={histTotal > 0}
        page={page}
        totalPages={totalPages}
      />
    </>
  );
}
