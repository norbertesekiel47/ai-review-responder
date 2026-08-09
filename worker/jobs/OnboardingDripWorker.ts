import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../src/lib/shared/subscription-guard';
import {
  markOutboxCompleted,
  markOutboxCompletedWithReason,
  markOutboxFailed,
  extractOutboxHandle,
} from '../../src/lib/shared/outbox';
import { OUTBOX_COMPLETION_REASON } from '../../src/lib/shared/outbox-completion-reason';
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
import { resolveDashboardUrl } from './summary-report-helpers';

/**
 * **Drip staleness cap** — the single owner of the policy (#719).
 *
 * It lives here rather than in `OnboardingDripScheduler.ts`, which imports it,
 * because that module registers a guarded poll at import time; importing it from
 * this worker would start a poller as a side effect of loading a job handler.
 * This module has no import-time side effects, so the edge is safe in this
 * direction only.
 */
export const DRIP_STALENESS_GRACE_DAYS = 3;

/** Days after `subscription_activated_at` at which each drip becomes due. */
export const DRIP_DAY_OFFSETS: Record<OnboardingDripPayload['drip_type'], number> = {
  day_1: 1,
  day_7: 7,
  day_30: 30,
};

const MS_PER_DAY = 86_400_000;

/**
 * True when the drip's due date passed more than the grace window ago.
 *
 * Boundary matches the scheduler exactly: the cap is
 * `activated + days + GRACE`, and a drip sitting precisely ON it still sends —
 * the comparison is strictly `<`, so equality is NOT stale. Getting this
 * backwards would silently drop every drip that lands on the boundary.
 *
 * Returns `false` when the anchor is null: staleness is not computable without
 * it, and the null case is already owned upstream — day_7/day_30 take the
 * pre-existing `markOutboxFailed` path (an intake edge case that must stay
 * unchanged), and day_1 with a null anchor is not something the scheduler can
 * produce. Deliberately NOT fail-closed there, because closing it would rewrite
 * a contract path this ticket promised to leave alone.
 */
export function isDripTooStale(
  dripType: OnboardingDripPayload['drip_type'],
  activatedAt: Date | null,
  asOf: Date,
): boolean {
  if (!activatedAt) return false;
  const capMs =
    activatedAt.getTime() + (DRIP_DAY_OFFSETS[dripType] + DRIP_STALENESS_GRACE_DAYS) * MS_PER_DAY;
  return capMs < asOf.getTime();
}

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
    await markOutboxFailed(sql, outboxId, 'business_not_found', outboxAttempt);
    return;
  }

  // ── 2. Only entitled (active or trialing) subscriptions get drip emails ──
  if (!subscriptionGrantsFullAccess(business.subscription_status)) {
    logger.log(`Business ${businessId} not entitled (${business.subscription_status}) — skipping ${drip_type}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
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
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // ── Hard bounce check ──────────────────────────────────
  // Skip owner-directed emails when the owner's email has hard-bounced.
  // Admin verifies and clears owner_email_bounced manually from /admin/businesses/[id].
  if (business.owner_email_bounced) {
    logger.log(`Business ${businessId} owner email bounced — skipping ${drip_type}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // ── 3. Validate subscription_activated_at for day_7/day_30 ─────────
  if ((drip_type === 'day_7' || drip_type === 'day_30') && !business.subscription_activated_at) {
    logger.warn(`${drip_type} skipped: subscription_activated_at is null for ${businessId}`);
    await markOutboxFailed(sql, outboxId, 'subscription_activated_at is null', outboxAttempt);
    return;
  }

  // ── 3b. Drip staleness cap — fail-closed chokepoint (#719 review A1) ──
  // The scheduler already excludes stale pairs, so in the normal path this never
  // fires. It exists because producer-only enforcement is not enforcement: an
  // operator re-driving a failed row, a future second producer, or a row minted
  // just inside the boundary and left undispatched through a multi-day worker
  // outage all reach this handler with the producer's check long expired — and
  // the result is a "Welcome to RepWorth!" arriving months late.
  //
  // This mirrors #679's `guardImportConsent`, which added exactly this shape for
  // exactly this reason after producer-side gating was judged insufficient.
  //
  // Placed BEFORE the drip-log claim on purpose: a refused drip must not consume
  // the (business_id, drip_type) claim, or a legitimate re-send could never take
  // it. It completes rather than fails the row — a policy refusal is the guard
  // working, not an incident — and carries a durable `completion_reason` so a
  // refusal is separable in SQL from a genuine send (the #695 half of the
  // pattern), which the log line alone could not provide once logs age out.
  //
  // No SELECT … FOR UPDATE here, unlike #679: that guard serialized against an
  // owner concurrently accepting an offer. Staleness is a pure function of
  // `subscription_activated_at` and the clock, and nothing mutates the anchor,
  // so there is no race to serialize against.
  if (isDripTooStale(drip_type, business.subscription_activated_at, new Date())) {
    logger.warn(`${drip_type} refused by the staleness cap`, {
      business_id: businessId,
      drip_type,
      grace_days: DRIP_STALENESS_GRACE_DAYS,
    });
    await markOutboxCompletedWithReason(
      sql,
      outboxId,
      OUTBOX_COMPLETION_REASON.DRIP_TOO_STALE,
      outboxAttempt,
    );
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
      await markOutboxCompleted(sql, outboxId, outboxAttempt);
      return;
    }
  }

  const appUrl = getWorkerConfig().NEXT_PUBLIC_APP_URL;

  // ── 5. Dashboard URL (null when the owner has no auth) ────────────
  const dashboardUrl = await resolveDashboardUrl(sql, businessId, appUrl);

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
      await markOutboxFailed(sql, outboxId, `unknown drip_type: ${drip_type}`, outboxAttempt);
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
  await recordNotificationDelivery(sql, {
    accountId: business.account_id,
    businessId: businessId,
    channel: 'email',
    recipient: business.owner_email,
    template: `onboarding_drip_${drip_type}`,
    externalMessageId: messageId,
  });

  await markOutboxCompleted(sql, outboxId, outboxAttempt);

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
      const { rawToken } = await createApprovalLink(sql, {
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

  // Staff sign-off name — resolved only from the onboarding staff member on
  // businesses.onboarded_by. The former business-scoped-admin branch read
  // users.business_id (dropped in migration 034) and is deleted rather than
  // ported, because narrowing the sign-off to businesses.onboarded_by is the
  // signed-off behaviour change (intake user_visible_behavior).
  //
  // It is NOT deleted because "a rewrite could not match" — that claim was made
  // during planning and is false (#719 step-7 review A4). Migration 034 §5d
  // backfills users.account_id from users.business_id with NO role filter, so
  // pre-034 business-scoped admins DO carry a non-null account_id and an
  // account-scoped rewrite would have matched some of them. The behaviour change
  // is deliberate; the original justification for it was wrong.
  const [onboarder] = await sql<{ name: string }[]>`
    SELECT u.name FROM users u
    JOIN businesses b ON b.onboarded_by = u.id
    WHERE b.id = ${business.id} AND u.role = 'admin'
    LIMIT 1
  `;
  const supportContactName: string | null = onboarder?.name ?? null;

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
