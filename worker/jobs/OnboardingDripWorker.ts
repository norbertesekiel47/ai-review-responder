import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import {
  sendInternalEmail,
  buildOnboardingDay1Html,
  buildOnboardingDay7Html,
  buildOnboardingDay30Html,
} from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { createApprovalLink } from '../../src/lib/approval/create-link';
import type { OnboardingDripPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[OnboardingDripWorker]';

export async function handleOnboardingDrip(job: Job<OnboardingDripPayload>): Promise<void> {
  const { business_id, drip_type } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // ── 1. Load business ─────────────────────────────────────────────
  const [business] = await sql<{
    id: string;
    name: string;
    owner_name: string;
    owner_email: string;
    subscription_status: string;
    updated_at: Date;
    initial_review_count: number | null;
    initial_responded_count: number | null;
    subscription_activated_at: Date | null;
  }[]>`
    SELECT id, name, owner_name, owner_email, subscription_status, updated_at,
           initial_review_count, initial_responded_count, subscription_activated_at
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    console.warn(`${LOG_PREFIX} Business ${business_id} not found`);
    await markOutboxFailed(outboxId, 'business_not_found');
    return;
  }

  // ── 2. Only active subscriptions get drip emails ──────────────────
  if (business.subscription_status !== 'active') {
    console.log(`${LOG_PREFIX} Business ${business_id} not active (${business.subscription_status}) — skipping ${drip_type}`);
    await markOutboxCompleted(outboxId);
    return;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  // ── 3. Check owner has auth (for dashboard URL) ───────────────────
  const [ownerWithAuth] = await sql<{ id: string }[]>`
    SELECT id FROM users
    WHERE business_id = ${business_id} AND role = 'owner' AND auth_id IS NOT NULL
    LIMIT 1
  `;
  const dashboardUrl = ownerWithAuth && appUrl ? `${appUrl}/dashboard` : null;

  // ── 4. Branch on drip type ────────────────────────────────────────
  let html: string;
  let subject: string;

  switch (drip_type) {
    case 'day_1':
      ({ html, subject } = await buildDay1(business, dashboardUrl));
      break;
    case 'day_7':
      ({ html, subject } = await buildDay7(business, appUrl));
      break;
    case 'day_30':
      ({ html, subject } = await buildDay30(business));
      break;
    default: {
      console.warn(`${LOG_PREFIX} Unknown drip_type: ${drip_type}`);
      await markOutboxFailed(outboxId, `unknown drip_type: ${drip_type}`);
      return;
    }
  }

  // ── 5. Mark outbox completed BEFORE sending (crash-safe) ──────────
  await markOutboxCompleted(outboxId);

  // ── 6. Send email ─────────────────────────────────────────────────
  const { messageId } = await sendInternalEmail({
    to: business.owner_email,
    subject,
    bodyHtml: html,
  });

  // ── 7. Record in drip log (idempotent) ────────────────────────────
  await sql`
    INSERT INTO onboarding_drip_log (id, business_id, drip_type)
    VALUES (${uuidv7()}, ${business_id}, ${drip_type})
    ON CONFLICT (business_id, drip_type) DO NOTHING
  `;

  // ── 8. Record delivery ────────────────────────────────────────────
  await recordNotificationDelivery({
    businessId: business_id,
    channel: 'email',
    recipient: business.owner_email,
    template: `onboarding_drip_${drip_type}`,
    externalMessageId: messageId,
  });

  console.log(`${LOG_PREFIX} ${drip_type} sent to ${business.owner_email} for ${business.name}`);
}

// ── Day 1: Welcome email ────────────────────────────────────────────

interface BusinessRow {
  id: string;
  name: string;
  owner_name: string;
  owner_email: string;
  subscription_activated_at: Date | null;
  initial_review_count: number | null;
  initial_responded_count: number | null;
}

async function buildDay1(
  business: BusinessRow,
  dashboardUrl: string | null,
): Promise<{ html: string; subject: string }> {
  const html = buildOnboardingDay1Html({
    businessName: business.name,
    ownerName: business.owner_name,
    dashboardUrl,
  });
  return { html, subject: `Welcome to RepWorth, ${business.owner_name}!` };
}

// ── Day 7: First week recap ─────────────────────────────────────────

async function buildDay7(
  business: BusinessRow,
  appUrl: string | undefined,
): Promise<{ html: string; subject: string }> {
  const activatedAt = business.subscription_activated_at ?? business.id; // fallback shouldn't happen

  // Reviews handled (approved/edited/posted/awaiting_manual_post)
  const [reviewsRow] = await sql<{ reviews_handled: number }[]>`
    SELECT COUNT(DISTINCT resp.review_id)::int AS reviews_handled
    FROM responses resp
    WHERE resp.business_id = ${business.id}
      AND resp.status IN ('approved','edited','posted','awaiting_manual_post')
      AND resp.created_at >= ${activatedAt}
  `;
  const reviewsHandled = reviewsRow?.reviews_handled ?? 0;

  // Highlight review (longest review text among handled responses)
  const [highlight] = await sql<{
    reviewer_name: string;
    star_rating: number;
    review_text: string;
    approved_text: string;
  }[]>`
    SELECT r.reviewer_name, r.star_rating, r.review_text, resp.approved_text
    FROM responses resp JOIN reviews r ON r.id = resp.review_id
    WHERE resp.business_id = ${business.id}
      AND resp.status IN ('approved','edited','posted','awaiting_manual_post')
      AND r.review_text IS NOT NULL
    ORDER BY LENGTH(r.review_text) DESC LIMIT 1
  `;
  const highlightReview = highlight
    ? {
        reviewerName: highlight.reviewer_name,
        starRating: highlight.star_rating,
        reviewText: highlight.review_text,
        responseText: highlight.approved_text,
      }
    : null;

  // Has edits
  const [hasEditsRow] = await sql<{ exists: number }[]>`
    SELECT 1 AS exists FROM responses
    WHERE business_id = ${business.id}
      AND edited_text IS NOT NULL AND status IN ('edited','posted')
    LIMIT 1
  `;
  const hasEdits = !!hasEditsRow;

  // Pending reviews (up to 5)
  const pendingRows = await sql<{
    response_id: string;
    reviewer_name: string;
    star_rating: number | null;
  }[]>`
    SELECT resp.id AS response_id, r.reviewer_name, r.star_rating
    FROM responses resp JOIN reviews r ON r.id = resp.review_id
    WHERE resp.business_id = ${business.id} AND resp.status = 'pending_approval'
    ORDER BY resp.created_at ASC LIMIT 5
  `;

  // Create approval links for pending reviews
  const pendingReviews: Array<{ reviewerName: string; starRating: number | null; approvalUrl: string }> = [];
  if (appUrl) {
    for (const row of pendingRows) {
      const { rawToken } = await createApprovalLink({
        responseId: row.response_id,
        businessId: business.id,
        revokeMode: 'orphaned_only',
      });
      pendingReviews.push({
        reviewerName: row.reviewer_name,
        starRating: row.star_rating,
        approvalUrl: `${appUrl}/approve/${rawToken}`,
      });
    }
  }

  // Response rate: total reviews for this business
  const [totalRow] = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total FROM reviews WHERE business_id = ${business.id}
  `;
  const totalReviews = totalRow?.total ?? 0;
  const responseRate = totalReviews > 0 ? Math.round((reviewsHandled / totalReviews) * 100) : 0;

  const html = buildOnboardingDay7Html({
    businessName: business.name,
    ownerName: business.owner_name,
    reviewsHandled,
    timeSavedMinutes: reviewsHandled * 7,
    responseRate,
    highlightReview,
    hasEdits,
    pendingReviews,
  });

  return { html, subject: `Your first week with RepWorth — ${business.name}` };
}

// ── Day 30: First month impact ──────────────────────────────────────

async function buildDay30(
  business: BusinessRow,
): Promise<{ html: string; subject: string }> {
  // Total reviews
  const [totalRow] = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total FROM reviews WHERE business_id = ${business.id}
  `;
  const totalReviews = totalRow?.total ?? 0;

  // Responded (non-superseded, non-failed)
  const [respondedRow] = await sql<{ responded: number }[]>`
    SELECT COUNT(DISTINCT review_id)::int AS responded
    FROM responses WHERE business_id = ${business.id}
      AND status IN ('approved','edited','posted','awaiting_manual_post')
  `;
  const responded = respondedRow?.responded ?? 0;

  // Response rate now
  const responseRateNow = totalReviews > 0 ? Math.round((responded / totalReviews) * 100) : 0;

  // Baseline response rate from initial counts
  let responseRateBefore: number | null = null;
  if (
    business.initial_review_count !== null &&
    business.initial_review_count > 0 &&
    business.initial_responded_count !== null
  ) {
    responseRateBefore = Math.round(
      (business.initial_responded_count / business.initial_review_count) * 100,
    );
  }

  // Ranking change
  let rankingChange: { keyword: string; from: number; to: number } | null = null;
  const [latestRanking] = await sql<{ keyword: string; rank_position: number }[]>`
    SELECT keyword, rank_position FROM ranking_snapshots
    WHERE business_id = ${business.id} AND rank_position IS NOT NULL
    ORDER BY snapshot_date DESC LIMIT 1
  `;
  if (latestRanking) {
    const [earliestRanking] = await sql<{ rank_position: number }[]>`
      SELECT rank_position FROM ranking_snapshots
      WHERE business_id = ${business.id} AND keyword = ${latestRanking.keyword} AND rank_position IS NOT NULL
      ORDER BY snapshot_date ASC LIMIT 1
    `;
    if (earliestRanking) {
      rankingChange = {
        keyword: latestRanking.keyword,
        from: earliestRanking.rank_position,
        to: latestRanking.rank_position,
      };
    }
  }

  // Sales partner name
  const [salesPartner] = await sql<{ name: string }[]>`
    SELECT name FROM users WHERE role IN ('admin','sales_partner') LIMIT 1
  `;
  const salesPartnerName = salesPartner?.name ?? null;

  const timeSavedMinutes = responded * 7;

  const html = buildOnboardingDay30Html({
    businessName: business.name,
    ownerName: business.owner_name,
    totalReviews,
    responseRateBefore,
    responseRateNow,
    timeSavedMinutes,
    rankingChange,
    salesPartnerName,
  });

  return { html, subject: `Your first month with RepWorth — ${business.name}` };
}
