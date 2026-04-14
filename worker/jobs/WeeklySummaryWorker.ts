import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { sendInternalEmail, buildWeeklySummaryEmailHtml } from '../../src/lib/notifications/email';
import type { WeeklySummaryPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[WeeklySummaryWorker]';

export async function handleWeeklySummary(
  job: Job<WeeklySummaryPayload>,
): Promise<void> {
  const { business_id, week_start_date } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // ── 1. Load business ──────────────────────────────────────────────
  const [business] = await sql<{
    id: string;
    name: string;
    owner_email: string;
    subscription_status: string;
    updated_at: Date;
  }[]>`
    SELECT id, name, owner_email, subscription_status, updated_at
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
    SELECT COUNT(*)::text AS count FROM responses
    WHERE business_id = ${business_id}
      AND status IN ('posted', 'approved', 'edited', 'awaiting_manual_post')
      AND created_at >= ${week_start_date}::date
      AND created_at < ${weekEndDate}::date
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

  // ── 4. Upsert weekly_summaries row (idempotent) ───────────────────
  const [upsertRow] = await sql<{ sent_at: string | null }[]>`
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
    RETURNING sent_at
  `;

  // If the upsert returned no row, the ON CONFLICT WHERE clause prevented the
  // update because sent_at IS NOT NULL — meaning the summary was already sent.
  if (!upsertRow) {
    console.log(`${LOG_PREFIX} Weekly summary for ${business_id} week ${week_start_date} already sent`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── 5. Build email ────────────────────────────────────────────────
  const html = buildWeeklySummaryEmailHtml({
    businessName: business.name,
    weekStartDate: week_start_date,
    weekEndDate: weekEndDate,
    totalReviews,
    totalResponded,
    notableReviews: notableReviews.map((r) => ({
      reviewerName: r.reviewer_name,
      starRating: r.star_rating,
      reviewText: r.review_text,
    })),
  });

  // ── 6. Mark as sent BEFORE sending (crash-safe) ───────────────────
  await sql`
    UPDATE weekly_summaries
    SET sent_at = NOW()
    WHERE business_id = ${business_id} AND week_start_date = ${week_start_date}::date
  `;

  // ── 7. Send email ─────────────────────────────────────────────────
  const weekLabel = `${week_start_date} to ${weekEndDate}`;
  try {
    await sendInternalEmail({
      to: business.owner_email,
      subject: `Weekly Review Summary — ${business.name} (${weekLabel})`,
      bodyHtml: html,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to send weekly summary for ${business.name} (week ${week_start_date}): ${err instanceof Error ? err.message : err}`);
    await markOutboxFailed(outboxId, err instanceof Error ? err.message : String(err));
    return;
  }

  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} Weekly summary sent for ${business.name} (week ${week_start_date})`);
}
