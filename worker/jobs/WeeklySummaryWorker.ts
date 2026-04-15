import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { sendInternalEmail, buildWeeklyValueReportHtml } from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { generateReviewSummary } from '../../src/lib/responses/review-summary';
import type { WeeklySummaryPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[WeeklySummaryWorker]';

export async function handleWeeklySummary(
  job: Job<WeeklySummaryPayload>,
): Promise<void> {
  const { business_id, week_start_date } = job.data;
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
  }[]>`
    SELECT id, name, owner_email, subscription_status, updated_at,
           initial_review_count, initial_responded_count, baseline_captured_at
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

  // ── 3. Query week stats ───────────────────────────────────────────
  const weekEnd = new Date(week_start_date + 'T00:00:00Z');
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const weekEndDate = weekEnd.toISOString().slice(0, 10);

  const [reviewCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM reviews
    WHERE business_id = ${business_id}
      AND detected_at >= ${week_start_date}::date
      AND detected_at < ${weekEndDate}::date
  `;

  const [respondedCount] = await sql<{ count: string }[]>`
    SELECT COUNT(DISTINCT r.id)::text AS count FROM reviews r
    JOIN responses resp ON resp.review_id = r.id
      AND resp.status IN ('posted', 'approved', 'edited', 'awaiting_manual_post')
    WHERE r.business_id = ${business_id}
      AND r.detected_at >= ${week_start_date}::date
      AND r.detected_at < ${weekEndDate}::date
  `;

  const notableReviews = await sql<{
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
  }[]>`
    SELECT reviewer_name, star_rating, review_text FROM reviews
    WHERE business_id = ${business_id}
      AND star_rating <= 2
      AND detected_at >= ${week_start_date}::date
      AND detected_at < ${weekEndDate}::date
    ORDER BY detected_at DESC
    LIMIT 5
  `;

  const totalReviews = parseInt(reviewCount?.count ?? '0', 10);
  const totalResponded = parseInt(respondedCount?.count ?? '0', 10);

  // ── 4. Additional queries for value report ────────────────────────

  // 4a. Reviews for intelligence brief (texts for LLM summarization)
  const reviewsForSummary = await sql<{
    star_rating: number;
    review_text: string | null;
  }[]>`
    SELECT star_rating, review_text FROM reviews
    WHERE business_id = ${business_id}
      AND detected_at >= ${week_start_date}::date
      AND detected_at < ${weekEndDate}::date
      AND review_text IS NOT NULL
    ORDER BY detected_at DESC
    LIMIT 30
  `;

  // 4b. 4-week average review count
  const [avgRow] = await sql<{ avg: string }[]>`
    SELECT COALESCE(
      (SELECT COUNT(*)::float / 4.0 FROM reviews
       WHERE business_id = ${business_id}
         AND detected_at >= (${week_start_date}::date - INTERVAL '28 days')
         AND detected_at < ${week_start_date}::date),
      0
    )::text AS avg
  `;
  const fourWeekAvgReviews = parseFloat(avgRow?.avg ?? '0');

  // 4c. Ranking snapshot (conditional, no SerpAPI calls)
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

  // 4d. Dashboard link eligibility
  const [ownerWithAuth] = await sql<{ exists: number }[]>`
    SELECT 1 AS exists FROM users
    WHERE business_id = ${business_id} AND role = 'owner' AND auth_id IS NOT NULL
    LIMIT 1
  `;
  const dashboardUrl = ownerWithAuth
    ? `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`
    : null;

  // ── 5. Upsert weekly_summaries row (idempotent) ───────────────────
  const [upsertRow] = await sql<{ sent_at: string | null; summary_text: string | null }[]>`
    INSERT INTO weekly_summaries (id, business_id, week_start_date, total_reviews, total_responded, notable_reviews)
    VALUES (
      ${uuidv7()}, ${business_id}, ${week_start_date}::date,
      ${totalReviews}, ${totalResponded},
      ${JSON.stringify(notableReviews)}::jsonb
    )
    ON CONFLICT (business_id, week_start_date)
    DO UPDATE SET
      total_reviews = EXCLUDED.total_reviews,
      total_responded = EXCLUDED.total_responded,
      notable_reviews = EXCLUDED.notable_reviews
    WHERE weekly_summaries.sent_at IS NULL
    RETURNING sent_at, summary_text
  `;

  // If the upsert returned no row, the ON CONFLICT WHERE clause prevented the
  // update because sent_at IS NOT NULL — meaning the summary was already sent.
  if (!upsertRow) {
    console.log(`${LOG_PREFIX} Weekly summary for ${business_id} week ${week_start_date} already sent`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── 5b. Claim: atomically set sent_at to prevent duplicate sends ──
  // The upsert above auto-commits and does NOT hold a lock across the
  // rest of the worker. Without this claim, two concurrent jobs could
  // both pass the upsert (both see sent_at IS NULL) and both proceed
  // through the LLM call + email send. This conditional UPDATE is
  // atomic — only one concurrent job wins the claim.
  const [claimed] = await sql<{ id: string }[]>`
    UPDATE weekly_summaries
    SET sent_at = NOW()
    WHERE business_id = ${business_id}
      AND week_start_date = ${week_start_date}::date
      AND sent_at IS NULL
    RETURNING id
  `;
  if (!claimed) {
    console.log(`${LOG_PREFIX} Weekly summary for ${business_id} week ${week_start_date} claimed by another worker`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── 6. Intelligence brief (reuse existing or generate) ────────────
  let intelligenceBrief: string | null = upsertRow.summary_text ?? null;

  if (!intelligenceBrief && reviewsForSummary.length > 0) {
    const summaryResult = await generateReviewSummary(
      reviewsForSummary.map((r) => ({
        starRating: r.star_rating,
        reviewText: r.review_text,
      })),
      business_id,
    );
    intelligenceBrief = summaryResult?.summaryText ?? null;

    // Persist the summary_text for idempotent retries
    if (intelligenceBrief) {
      await sql`
        UPDATE weekly_summaries
        SET summary_text = ${intelligenceBrief}
        WHERE business_id = ${business_id} AND week_start_date = ${week_start_date}::date
      `;
    }
  }

  // ── 7. Compute baseline response rate ─────────────────────────────
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

  // ── 8. Build email ────────────────────────────────────────────────
  const html = buildWeeklyValueReportHtml({
    businessName: business.name,
    weekStartDate: week_start_date,
    weekEndDate,
    totalReviews,
    totalResponded,
    notableReviews: notableReviews.map((r) => ({
      reviewerName: r.reviewer_name,
      starRating: r.star_rating,
      reviewText: r.review_text,
    })),
    intelligenceBrief,
    baselineResponseRate,
    fourWeekAvgReviews,
    ranking,
    dashboardUrl,
  });

  // sent_at already claimed in step 5b (crash-safe: set before send)

  // ── 9. Send email ─────────────────────────────────────────────────
  const weekLabel = `${week_start_date} to ${weekEndDate}`;
  let messageId: string;
  try {
    const result = await sendInternalEmail({
      to: business.owner_email,
      subject: `Weekly Value Report — ${business.name} (${weekLabel})`,
      bodyHtml: html,
    });
    messageId = result.messageId;
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to send weekly value report for ${business.name} (week ${week_start_date}): ${err instanceof Error ? err.message : err}`);
    await markOutboxFailed(outboxId, err instanceof Error ? err.message : String(err));
    return;
  }

  // ── 11. Record notification delivery ──────────────────────────────
  await recordNotificationDelivery({
    businessId: business_id,
    channel: 'email',
    recipient: business.owner_email,
    template: 'weekly_value_report',
    externalMessageId: messageId,
  });

  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} Weekly value report sent for ${business.name} (week ${week_start_date})`);
}
