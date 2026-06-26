import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../src/lib/config/worker';
import {
  sendInternalEmail,
  buildOnboardingDay1Html,
  buildOnboardingDay7Html,
  buildOnboardingDay30Html,
} from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { createApprovalLink } from '../../src/lib/approval/create-link';
import type { OnboardingDripPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { HANDLED_STATUSES } from '../../src/lib/shared/response-status';
import { asLocationId } from '../../src/lib/shared/ids';
import type { LocationId } from '../../src/lib/shared/ids';
import { subscriptionGrantsFullAccess } from '../../src/lib/shared/subscription-status';

export async function handleOnboardingDrip(job: Job<OnboardingDripPayload>): Promise<void> {
  const logger = createWorkerLogger('[OnboardingDripWorker]', job.data.correlation_id);
  const { drip_type } = job.data;
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // ── 1. Load business ─────────────────────────────────────────────
  const [business] = await sql<{
    id: string;
    account_id: string;
    name: string;
    owner_name: string;
    owner_email: string;
    owner_email_bounced: boolean;
    subscription_status: string;
    account_past_due_at: Date | null;
    account_flags: AccountFlagsInput;
    initial_review_count: number | null;
    initial_responded_count: number | null;
    subscription_activated_at: Date | null;
  }[]>`
    SELECT b.id, b.name, b.owner_name, b.owner_email, b.owner_email_bounced,
           a.id AS account_id, a.subscription_status,
           a.past_due_at AS account_past_due_at, a.flags AS account_flags,
           b.initial_review_count, b.initial_responded_count, b.subscription_activated_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}
  `;

  if (!business) {
    logger.warn(`Business ${businessId} not found`);
    await markOutboxFailed(outboxId, 'business_not_found', outboxAttempt);
    return;
  }

  // ── 2. Only entitled (active or trialing) subscriptions get drip emails ──
  if (!subscriptionGrantsFullAccess(business.subscription_status)) {
    logger.log(`Business ${businessId} not entitled (${business.subscription_status}) — skipping ${drip_type}`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const subCheck = checkSubscription({
    status: business.subscription_status,
    pastDueAt: business.account_past_due_at,
    accountFlags: business.account_flags ?? {},
    workerType: 'notification',
  });
  if (!subCheck.allowed) {
    logger.log(`Business ${businessId} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Hard bounce check ──────────────────────────────────
  // Skip owner-directed emails when the owner's email has hard-bounced.
  // Admin verifies and clears owner_email_bounced manually from /admin/businesses/[id].
  if (business.owner_email_bounced) {
    logger.log(`Business ${businessId} owner email bounced — skipping ${drip_type}`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── 3. Validate subscription_activated_at for day_7/day_30 ─────────
  if ((drip_type === 'day_7' || drip_type === 'day_30') && !business.subscription_activated_at) {
    logger.warn(`${drip_type} skipped: subscription_activated_at is null for ${businessId}`);
    await markOutboxFailed(outboxId, 'subscription_activated_at is null', outboxAttempt);
    return;
  }

  // ── 4. Claim drip log entry BEFORE any side effects ───────────────
  // Three-way claim: INSERT new → own outbox retry → stale takeover.
  // Only the claim owner can proceed to build/send. Concurrent duplicates
  // see a fresh claim owned by another outbox_id and skip.
  const STALE_CLAIM_MINUTES = 15;
  let claimId: string;

  // Try INSERT first
  const [inserted] = await sql<{ id: string }[]>`
    INSERT INTO onboarding_drip_log (id, business_id, drip_type, sent_at, claimed_at, claimed_by_outbox_id)
    VALUES (${uuidv7()}, ${businessId}, ${drip_type}, NULL, NOW(), ${outboxId})
    ON CONFLICT (business_id, drip_type) DO NOTHING
    RETURNING id
  `;

  if (inserted) {
    claimId = inserted.id;
  } else {
    // Row exists — try atomic takeover for own retry or stale claim.
    // Conditions: sent_at IS NULL (not yet sent) AND either same outbox owns it
    // or the claim is older than STALE_CLAIM_MINUTES (previous attempt abandoned).
    const [taken] = await sql<{ id: string }[]>`
      UPDATE onboarding_drip_log
      SET claimed_at = NOW(), claimed_by_outbox_id = ${outboxId}
      WHERE business_id = ${businessId} AND drip_type = ${drip_type}
        AND sent_at IS NULL
        AND (
          claimed_by_outbox_id = ${outboxId}
          OR claimed_at < NOW() - ${STALE_CLAIM_MINUTES} * INTERVAL '1 minute'
        )
      RETURNING id
    `;

    if (taken) {
      claimId = taken.id;
      logger.log(`${drip_type} claim taken over for ${businessId}`);
    } else {
      // Either already sent or owned by another active job — skip
      logger.log(`${drip_type} already claimed/sent for ${businessId} — skipping`);
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    }
  }

  const appUrl = getWorkerConfig().NEXT_PUBLIC_APP_URL;

  // ── 5. Check owner has auth (for dashboard URL) ───────────────────
  const [ownerWithAuth] = await sql<{ id: string }[]>`
    SELECT id FROM users
    WHERE business_id = ${businessId} AND role = 'owner' AND auth_id IS NOT NULL
    LIMIT 1
  `;
  const dashboardUrl = ownerWithAuth && appUrl ? `${appUrl}/dashboard` : null;

  // ── 6. Branch on drip type and build email ────────────────────────
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
      logger.warn(`Unknown drip_type: ${drip_type}`);
      await markOutboxFailed(outboxId, `unknown drip_type: ${drip_type}`, outboxAttempt);
      return;
    }
  }

  // ── 7. Send email ─────────────────────────────────────────────────
  const { messageId } = await sendInternalEmail({
    to: business.owner_email,
    subject,
    bodyHtml: html,
    category: 'marketing',
  });

  // ── 8. Mark sent_at after successful delivery ─────────────────────
  await sql`
    UPDATE onboarding_drip_log SET sent_at = NOW() WHERE id = ${claimId}
  `;

  // ── 9. Record delivery BEFORE outbox completion — ensures cooldown
  // checks in other workers can see this delivery record.
  await recordNotificationDelivery({
    accountId: business.account_id,
    businessId: businessId,
    channel: 'email',
    recipient: business.owner_email,
    template: `onboarding_drip_${drip_type}`,
    externalMessageId: messageId,
  });

  await markOutboxCompleted(outboxId, outboxAttempt);

  logger.log(`${drip_type} sent for business ${businessId}`);
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
  const activatedAt = business.subscription_activated_at;
  if (!activatedAt) {
    return { html: '', subject: '' };
  }
  // Window: activation → activation + 7 days
  const windowEnd = new Date(new Date(activatedAt).getTime() + 7 * 86_400_000);

  // Reviews handled within first-week window
  const [reviewsRow] = await sql<{ reviews_handled: number }[]>`
    SELECT COUNT(DISTINCT resp.review_id)::int AS reviews_handled
    FROM responses resp
    WHERE resp.business_id = ${business.id}
      AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
      AND resp.created_at >= ${activatedAt}
      AND resp.created_at < ${windowEnd}
  `;
  const reviewsHandled = reviewsRow?.reviews_handled ?? 0;

  // Highlight review within first-week window (longest review text)
  const [highlight] = await sql<{
    reviewer_name: string;
    star_rating: number;
    review_text: string;
    approved_text: string;
  }[]>`
    SELECT r.reviewer_name, r.star_rating, r.review_text, resp.approved_text
    FROM responses resp JOIN reviews r ON r.id = resp.review_id
    WHERE resp.business_id = ${business.id}
      AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
      AND r.review_text IS NOT NULL
      AND resp.created_at >= ${activatedAt}
      AND resp.created_at < ${windowEnd}
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

  // Has edits within first-week window
  const [hasEditsRow] = await sql<{ exists: number }[]>`
    SELECT 1 AS exists FROM responses
    WHERE business_id = ${business.id}
      AND edited_text IS NOT NULL AND status IN ('edited','posted')
      AND created_at >= ${activatedAt}
      AND created_at < ${windowEnd}
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
  // If pending reviews exist but NEXT_PUBLIC_APP_URL is missing, fail so retry
  // can succeed after config is fixed (matches owner-nudge strict behavior)
  const pendingReviews: Array<{ reviewerName: string; starRating: number | null; approvalUrl: string }> = [];
  if (pendingRows.length > 0 && !appUrl) {
    throw new Error('NEXT_PUBLIC_APP_URL not configured — cannot create approval links for day_7 drip');
  }
  if (appUrl) {
    for (const row of pendingRows) {
      const { rawToken } = await createApprovalLink({
        responseId: row.response_id,
        businessId: business.id,
        channel: 'email',
        revokeMode: 'orphaned_only',
      });
      pendingReviews.push({
        reviewerName: row.reviewer_name,
        starRating: row.star_rating,
        approvalUrl: `${appUrl}/approve/${rawToken}`,
      });
    }
  }

  // Total reviews within first-week window for response rate
  const [totalRow] = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total FROM reviews
    WHERE business_id = ${business.id}
      AND detected_at >= ${activatedAt}
      AND detected_at < ${windowEnd}
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
  const activatedAt = business.subscription_activated_at;
  if (!activatedAt) {
    return { html: '', subject: '' };
  }
  // Window: activation → activation + 30 days
  const windowEnd = new Date(new Date(activatedAt).getTime() + 30 * 86_400_000);

  // Total reviews within first-month window
  const [totalRow] = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total FROM reviews
    WHERE business_id = ${business.id}
      AND detected_at >= ${activatedAt}
      AND detected_at < ${windowEnd}
  `;
  const totalReviews = totalRow?.total ?? 0;

  // Responded within first-month window
  const [respondedRow] = await sql<{ responded: number }[]>`
    SELECT COUNT(DISTINCT review_id)::int AS responded
    FROM responses WHERE business_id = ${business.id}
      AND status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
      AND created_at >= ${activatedAt}
      AND created_at < ${windowEnd}
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

  // Staff sign-off name — same scoped chain as ResponsePublisherWorker:
  // 1. Business-scoped admin
  // 2. Onboarding staff via businesses.onboarded_by with role check
  // 3. null (no sign-off)
  let supportContactName: string | null = null;
  const [scopedAdmin] = await sql<{ name: string }[]>`
    SELECT name FROM users
    WHERE role = 'admin' AND business_id = ${business.id}
    LIMIT 1
  `;
  if (scopedAdmin) {
    supportContactName = scopedAdmin.name;
  } else {
    const [onboarder] = await sql<{ name: string }[]>`
      SELECT u.name FROM users u
      JOIN businesses b ON b.onboarded_by = u.id
      WHERE b.id = ${business.id} AND u.role = 'admin'
      LIMIT 1
    `;
    supportContactName = onboarder?.name ?? null;
  }

  const timeSavedMinutes = responded * 7;

  const html = buildOnboardingDay30Html({
    businessName: business.name,
    ownerName: business.owner_name,
    totalReviews,
    responseRateBefore,
    responseRateNow,
    timeSavedMinutes,
    rankingChange,
    supportContactName,
  });

  return { html, subject: `Your first month with RepWorth — ${business.name}` };
}
