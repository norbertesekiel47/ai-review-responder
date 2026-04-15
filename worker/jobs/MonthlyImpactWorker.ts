import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { sendInternalEmail, buildMonthlyImpactEmailHtml } from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { generateReviewSummary } from '../../src/lib/responses/review-summary';
import type { SendMonthlyImpactPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[MonthlyImpactWorker]';

export async function handleMonthlyImpact(
  job: Job<SendMonthlyImpactPayload>,
): Promise<void> {
  const { business_id, month_start_date } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // ── 1. Load business (including ROI baseline fields) ──────────────
  const [business] = await sql<{
    id: string;
    name: string;
    owner_email: string;
    subscription_status: string;
    updated_at: Date;
    initial_review_count: number | null;
    initial_responded_count: number | null;
    baseline_captured_at: Date | null;
    subscription_tier: string;
  }[]>`
    SELECT id, name, owner_email, subscription_status, updated_at,
           initial_review_count, initial_responded_count, baseline_captured_at,
           subscription_tier
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    console.warn(`${LOG_PREFIX} Business ${business_id} not found`);
    await markOutboxFailed(outboxId, 'business_not_found');
    return;
  }

  // ── 2. Subscription guard ─────────────────────────────────────────
  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    'summary',
  );

  if (!subCheck.allowed) {
    console.log(`${LOG_PREFIX} Business ${business_id} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── 3. Upsert monthly_impact_emails row (idempotent) ──────────────
  const [upsertRow] = await sql<{ sent_at: string | null; summary_text: string | null }[]>`
    INSERT INTO monthly_impact_emails (id, business_id, month_start_date)
    VALUES (${uuidv7()}, ${business_id}, ${month_start_date}::date)
    ON CONFLICT (business_id, month_start_date)
    DO UPDATE SET business_id = monthly_impact_emails.business_id
    WHERE monthly_impact_emails.sent_at IS NULL AND monthly_impact_emails.claimed_at IS NULL
    RETURNING sent_at, summary_text
  `;

  if (!upsertRow) {
    console.log(`${LOG_PREFIX} Monthly impact for ${business_id} month ${month_start_date} already sent`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── 3b. Claim: atomically set claimed_at to prevent duplicate sends ──
  // The upsert above auto-commits and does NOT hold a lock across the
  // rest of the worker. Without this claim, two concurrent jobs could
  // both pass the upsert (both see sent_at IS NULL) and both proceed
  // through the LLM call + email send. This conditional UPDATE is
  // atomic — only one concurrent job wins the claim.
  const [claimed] = await sql<{ id: string }[]>`
    UPDATE monthly_impact_emails
    SET claimed_at = NOW()
    WHERE business_id = ${business_id}
      AND month_start_date = ${month_start_date}::date
      AND claimed_at IS NULL
      AND sent_at IS NULL
    RETURNING id
  `;
  if (!claimed) {
    console.log(`${LOG_PREFIX} Monthly impact for ${business_id} month ${month_start_date} claimed by another worker`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── 4. Compute month boundaries ──────────────────────────────────
  const monthStart = new Date(month_start_date + 'T00:00:00Z');
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  const monthEndDate = monthEnd.toISOString().slice(0, 10);

  // ── 5. Query month stats ─────────────────────────────────────────
  const [reviewCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM reviews
    WHERE business_id = ${business_id}
      AND detected_at >= ${month_start_date}::date
      AND detected_at < ${monthEndDate}::date
  `;

  const [respondedCount] = await sql<{ count: string }[]>`
    SELECT COUNT(DISTINCT r.id)::text AS count FROM reviews r
    JOIN responses resp ON resp.review_id = r.id
      AND resp.status IN ('posted', 'approved', 'edited', 'awaiting_manual_post')
    WHERE r.business_id = ${business_id}
      AND r.detected_at >= ${month_start_date}::date
      AND r.detected_at < ${monthEndDate}::date
  `;

  const totalReviews = parseInt(reviewCount?.count ?? '0', 10);
  const totalResponded = parseInt(respondedCount?.count ?? '0', 10);

  // ── 6. Best review of the month ──────────────────────────────────
  const [bestReviewRow] = await sql<{
    reviewer_name: string;
    star_rating: number;
    review_text: string;
    response_text: string | null;
  }[]>`
    SELECT r.reviewer_name, r.star_rating, r.review_text,
           resp.approved_text AS response_text
    FROM reviews r
    LEFT JOIN responses resp ON resp.review_id = r.id
      AND resp.status IN ('posted', 'approved', 'edited', 'awaiting_manual_post')
    WHERE r.business_id = ${business_id}
      AND r.detected_at >= ${month_start_date}::date
      AND r.detected_at < ${monthEndDate}::date
      AND r.review_text IS NOT NULL
      AND r.star_rating IS NOT NULL
    ORDER BY r.star_rating DESC NULLS LAST, LENGTH(r.review_text) DESC
    LIMIT 1
  `;

  const bestReview = bestReviewRow
    ? {
        reviewerName: bestReviewRow.reviewer_name,
        starRating: bestReviewRow.star_rating,
        reviewText: bestReviewRow.review_text,
        responseText: bestReviewRow.response_text,
      }
    : null;

  // ── 7. Intelligence brief (reuse existing or generate) ────────────
  let intelligenceBrief: string | null = upsertRow.summary_text ?? null;

  if (!intelligenceBrief) {
    const reviewsForSummary = await sql<{
      star_rating: number;
      review_text: string | null;
    }[]>`
      SELECT star_rating, review_text FROM reviews
      WHERE business_id = ${business_id}
        AND detected_at >= ${month_start_date}::date
        AND detected_at < ${monthEndDate}::date
        AND review_text IS NOT NULL
        AND star_rating IS NOT NULL
      ORDER BY detected_at DESC
      LIMIT 30
    `;

    if (reviewsForSummary.length > 0) {
      const summaryResult = await generateReviewSummary(
        reviewsForSummary.map((r) => ({
          starRating: r.star_rating,
          reviewText: r.review_text,
        })),
        business_id,
        business.subscription_tier,
      );
      intelligenceBrief = summaryResult?.summaryText ?? null;

      if (intelligenceBrief) {
        await sql`
          UPDATE monthly_impact_emails
          SET summary_text = ${intelligenceBrief}
          WHERE business_id = ${business_id} AND month_start_date = ${month_start_date}::date
        `;
      }
    }
  }

  // ── 8. Ranking snapshot (conditional) ─────────────────────────────
  let ranking: { keyword: string; currentRank: number; initialRank: number } | null = null;
  const [latestRanking] = await sql<{
    keyword: string;
    rank_position: number;
  }[]>`
    SELECT keyword, rank_position FROM ranking_snapshots
    WHERE business_id = ${business_id} AND rank_position IS NOT NULL
    ORDER BY snapshot_date DESC LIMIT 1
  `;

  if (latestRanking) {
    const [initialRanking] = await sql<{ rank_position: number }[]>`
      SELECT rank_position FROM ranking_snapshots
      WHERE business_id = ${business_id} AND keyword = ${latestRanking.keyword} AND rank_position IS NOT NULL
      ORDER BY snapshot_date ASC LIMIT 1
    `;
    ranking = {
      keyword: latestRanking.keyword,
      currentRank: latestRanking.rank_position,
      initialRank: initialRanking?.rank_position ?? latestRanking.rank_position,
    };
  }

  // ── 9. Dashboard eligibility ─────────────────────────────────────
  const [ownerWithAuth] = await sql<{ exists: number }[]>`
    SELECT 1 AS exists FROM users
    WHERE business_id = ${business_id} AND role = 'owner' AND auth_id IS NOT NULL
    LIMIT 1
  `;
  const dashboardUrl = ownerWithAuth
    ? `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`
    : null;

  // ── 10. Compute values ───────────────────────────────────────────
  const responseRate = totalReviews > 0 ? Math.round((totalResponded / totalReviews) * 100) : 0;

  let baselineResponseRate: number | null = null;
  if (
    business.baseline_captured_at &&
    business.initial_review_count !== null &&
    business.initial_review_count > 0 &&
    business.initial_responded_count !== null
  ) {
    baselineResponseRate = Math.round(
      (business.initial_responded_count / business.initial_review_count) * 100,
    );
  }

  const timeSavedMinutes = totalResponded * 7;

  const monthLabel = new Date(month_start_date + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  // ── 11. Build email ──────────────────────────────────────────────
  const html = buildMonthlyImpactEmailHtml({
    businessName: business.name,
    monthLabel,
    totalReviews,
    totalResponded,
    responseRate,
    baselineResponseRate,
    timeSavedMinutes,
    intelligenceBrief,
    ranking,
    bestReview,
    dashboardUrl,
  });

  // ── 12. Mark sent_at just before Resend call (crash-safe) ─────────
  await sql`
    UPDATE monthly_impact_emails
    SET sent_at = NOW()
    WHERE business_id = ${business_id} AND month_start_date = ${month_start_date}::date
  `;

  // ── 13. Send email ───────────────────────────────────────────────
  let messageId: string;
  try {
    const result = await sendInternalEmail({
      to: business.owner_email,
      subject: `Monthly Impact Report — ${business.name} (${monthLabel})`,
      bodyHtml: html,
    });
    messageId = result.messageId;
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to send monthly impact report for ${business.name} (month ${month_start_date}): ${err instanceof Error ? err.message : err}`);
    await markOutboxFailed(outboxId, err instanceof Error ? err.message : String(err));
    return;
  }

  // ── 14. Record notification delivery ─────────────────────────────
  await recordNotificationDelivery({
    businessId: business_id,
    channel: 'email',
    recipient: business.owner_email,
    template: 'monthly_impact',
    externalMessageId: messageId,
  });

  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} Monthly impact report sent for ${business.name} (month ${month_start_date})`);
}
