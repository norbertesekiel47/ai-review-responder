import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { jsonResponse, errorResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import {
  SubscriptionStatus,
  subscriptionGrantsFullAccess,
} from '@/lib/shared/subscription-status';
import {
  getActiveDashboardData,
  BusinessNotFoundError,
} from '@/lib/dashboard/service';
import { getAggregateDashboardData } from '@/lib/dashboard/aggregate-service';
import { getLocationById } from '@/lib/locations/repo';
import { isValidUuid } from '@/lib/shared/ids';
import {
  computePastDueRecoveryState,
  type AccountFlagsInput,
  type PastDueRecoveryState,
} from '@/lib/shared/past-due-recovery';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import type { DashboardWindow } from '@/lib/kpi/types';
import { resolveDashboardRequest } from './policy';

export const dynamic = 'force-dynamic';

export type {
  DashboardDataActive,
} from '@/lib/dashboard/types';


function serializePastDueRecovery(recovery: PastDueRecoveryState) {
  return {
    pastDueAt: recovery.pastDueAt?.toISOString() ?? null,
    pastDueDeadline: recovery.deadline?.toISOString() ?? null,
    daysRemaining: recovery.daysRemaining,
    isReadOnly: recovery.isReadOnly,
  };
}

/** ISO trial-end, non-null only while trialing (trial_ends_at ⟺ status='trialing'). */
function trialEndsAtIso(
  subscriptionStatus: string,
  trialEndsAt: Date | string | null,
): string | null {
  return subscriptionStatus === SubscriptionStatus.TRIALING ? toIsoOrNull(trialEndsAt) : null;
}

/** pending_payment per-location response: admin-handoff vs self-serve pay CTA. */
function pendingPaymentResponse(
  subRow: { name: string; onboarded_by: string | null },
  locationId: string,
): NextResponse {
  // Admin-onboarded businesses get a handoff payload, never the self-serve
  // payment CTA — showing a payment link risks a double-charge via the partner.
  if (subRow.onboarded_by !== null) {
    return jsonResponse({
      subscriptionStatus: 'pending_payment_admin_handoff',
      locationId,
      businessName: subRow.name,
    });
  }
  // Self-serve owners are routed to /onboarding/pay (PlanPickerClient creates the
  // Checkout Session) — this replaces the old Payment Link URL flow.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return jsonResponse({
    subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
    locationId,
    businessName: subRow.name,
    paymentUrl: `${baseUrl}/onboarding/pay`,
  });
}

/**
 * Cancelled-account 30-day grace-period response, shared by the per-location and
 * aggregate paths (VAL-CROSS-011). Grace runs 30 days from cancelled_at (Stripe
 * webhook, migration 037), falling back to subscription_activated_at for legacy
 * rows; defaults to read access when neither date is known.
 */
async function cancelledGraceResponse(
  accountId: string,
  businessName: string,
): Promise<NextResponse> {
  const [cancelledRow] = await sql<{
    cancelled_at: Date | null;
    subscription_activated_at: Date | null;
  }[]>`
    SELECT cancelled_at, subscription_activated_at FROM accounts WHERE id = ${accountId}::uuid
  `;
  const cancellationDate = cancelledRow?.cancelled_at ?? cancelledRow?.subscription_activated_at;
  const gracePeriodEnd = cancellationDate
    ? new Date(new Date(cancellationDate).getTime() + 30 * 86_400_000)
    : null;
  const readAccess = gracePeriodEnd ? gracePeriodEnd > new Date() : true;
  return jsonResponse({
    subscriptionStatus: SubscriptionStatus.CANCELLED,
    businessName,
    gracePeriodEndDate: gracePeriodEnd?.toISOString() ?? null,
    readAccess,
  });
}

/** Whether an active/trialing owner still needs the onboarding business wizard. */
function isActivePendingBusiness(subRow: {
  subscription_status: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
}): boolean {
  return subscriptionGrantsFullAccess(subRow.subscription_status)
    && !subRow.place_id_verified
    && subRow.google_maps_url === null;
}

/** Past-due per-location payload: dashboard data + payment warning + recovery state. */
async function pastDuePerLocationResponse(
  subRow: {
    name: string;
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
    stripe_customer_id: string | null;
  },
  locationId: string,
  accountId: string,
  window: DashboardWindow,
): Promise<NextResponse> {
  const billingPortalUrl = subRow.stripe_customer_id ? `/api/billing/portal` : null;
  const recovery = computePastDueRecoveryState({
    subscriptionStatus: subRow.subscription_status,
    pastDueAt: subRow.past_due_at,
    accountFlags: subRow.flags,
  });
  const data = await getActiveDashboardData(sql, locationId, { includeReputationMetrics: true, window });
  return jsonResponse({
    ...data,
    subscriptionStatus: SubscriptionStatus.PAST_DUE,
    accountId,
    businessName: subRow.name,
    billingPortalUrl,
    ...serializePastDueRecovery(recovery),
  });
}

/**
 * Resolve the account's primary location and serve its dashboard as a scope
 * fallback (VAL-DASH-029). Returns null when there is no usable primary, so the
 * caller can return its own not-available error.
 */
async function fallbackToPrimary(
  accountId: string,
  window: DashboardWindow,
  reason: 'location_not_found' | 'location_archived',
  excludeLocationId?: string,
): Promise<NextResponse | null> {
  const primary = await getPrimaryLocationId(accountId);
  if (!primary || primary === excludeLocationId) return null;
  return fetchPerLocationData(primary, accountId, window, {
    scopeFallback: { reason, fallbackLocationId: primary },
  });
}

/** Returns the primary (or first active) location ID for an account. */
async function getPrimaryLocationId(accountId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND archived_at IS NULL
    ORDER BY is_primary DESC, created_at ASC
    LIMIT 1
  `;
  return row?.id ?? null;
}

/**
 * Fetches per-location dashboard data for a given location ID.
 * Handles subscription status checks, onboarding state, and returns
 * the appropriate response shape.
 *
 * @param locationId  The location to fetch data for.
 * @param accountId   The owner's account ID (for fallback resolution).
 * @param window      Validated analytics time-range window (issue #403).
 * @param fallback    If provided, a scopeFallback indicator to include in the response.
 */
async function fetchPerLocationData(
  locationId: string,
  accountId: string,
  window: DashboardWindow,
  fallback?: { scopeFallback: { reason: string; fallbackLocationId: string } },
): Promise<NextResponse> {
  const [subRow] = await sql<{
    name: string;
    subscription_status: string;
    subscription_tier: string;
    owner_email: string;
    onboarded_by: string | null;
    place_id_verified: boolean;
    google_maps_url: string | null;
    archived_at: Date | null;
    past_due_at: Date | string | null;
    trial_ends_at: Date | string | null;
    flags: AccountFlagsInput;
    stripe_customer_id: string | null;
  }[]>`
    SELECT b.name, a.subscription_status, a.subscription_tier,
           b.owner_email, b.onboarded_by,
           b.place_id_verified, b.google_maps_url,
           b.archived_at,
           a.past_due_at, a.trial_ends_at, a.flags, a.stripe_customer_id
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${locationId}
      AND b.account_id = ${accountId}::uuid
  `;

  if (!subRow) {
    return errorResponse('Business not found', 404);
  }

  // VAL-DASH-029: If the fallback location itself is archived, we're stuck
  if (subRow.archived_at !== null) {
    return errorResponse('No active location available', 404);
  }

  if (subRow.subscription_status === SubscriptionStatus.PENDING_PAYMENT) {
    return pendingPaymentResponse(subRow, locationId);
  }

  // VAL-CROSS-011: Cancelled account — 30-day grace period for read access
  if (subRow.subscription_status === SubscriptionStatus.CANCELLED) {
    return cancelledGraceResponse(accountId, subRow.name);
  }

  // VAL-CROSS-012: Past-due account — payment warning, features continue during grace
  if (subRow.subscription_status === SubscriptionStatus.PAST_DUE) {
    return pastDuePerLocationResponse(subRow, locationId, accountId, window);
  }

  // Active subscription but the owner skipped or never reached the
  // /onboarding/business wizard (e.g. bookmarked /dashboard from earlier
  // or closed the tab during the post-payment redirect). Surface a
  // CTA-only screen instead of the empty-state dashboard so they have
  // an obvious next action.
  if (isActivePendingBusiness(subRow)) {
    return jsonResponse({
      subscriptionStatus: 'active_pending_business',
      locationId,
      businessName: subRow.name,
    });
  }

  // Single-location landing requests reputation metrics so DashboardContent
  // renders the 4-zone reputation hero (PLAN.md PR2) instead of the legacy KPI
  // fallback. The past-due path above already opts in; this is the normal
  // active path.
  const data = await getActiveDashboardData(sql, locationId, { includeReputationMetrics: true, window });
  const trialEndsAt = trialEndsAtIso(subRow.subscription_status, subRow.trial_ends_at);

  // VAL-DASH-029: Attach scopeFallback indicator if a fallback occurred
  if (fallback) {
    return jsonResponse({ ...data, trialEndsAt, ...fallback });
  }

  return jsonResponse({ ...data, trialEndsAt });
}

/** Normalize a Postgres.js timestamp (Date or string) to an ISO string or null. */
function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface AggregateAccountRow {
  subscription_status: string;
  past_due_at: Date | string | null;
  trial_ends_at: Date | string | null;
  flags: AccountFlagsInput;
  stripe_customer_id: string | null;
}

// Aggregate (scope=all) subscription gating. Returns a response for any
// non-active subscription state; null means proceed with normal active
// aggregate data.
async function aggregateSubscriptionResponse(
  accountRow: AggregateAccountRow,
  accountId: string,
  window: DashboardWindow,
): Promise<NextResponse | null> {
  if (accountRow.subscription_status === SubscriptionStatus.PENDING_PAYMENT) {
    return jsonResponse({
      subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
      businessName: 'Account',
      paymentUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/onboarding/pay`,
    });
  }

  // VAL-CROSS-011: Cancelled account in aggregate mode
  if (accountRow.subscription_status === SubscriptionStatus.CANCELLED) {
    return cancelledGraceResponse(accountId, 'Account');
  }

  // VAL-CROSS-012: Past-due account in aggregate mode
  if (accountRow.subscription_status === SubscriptionStatus.PAST_DUE) {
    const billingPortalUrl = accountRow.stripe_customer_id
      ? `/api/billing/portal`
      : null;
    const recovery = computePastDueRecoveryState({
      subscriptionStatus: accountRow.subscription_status,
      pastDueAt: accountRow.past_due_at,
      accountFlags: accountRow.flags,
    });
    const data = await getAggregateDashboardData(sql, accountId, window);
    return jsonResponse({
      ...data,
      subscriptionStatus: SubscriptionStatus.PAST_DUE,
      businessName: 'Account',
      accountId,
      billingPortalUrl,
      ...serializePastDueRecovery(recovery),
    });
  }

  if (!subscriptionGrantsFullAccess(accountRow.subscription_status)) {
    return jsonResponse({
      subscriptionStatus: accountRow.subscription_status,
    });
  }

  return null;
}

// scope=all: account-wide aggregate dashboard data, gated by subscription state.
async function handleAggregateDashboard(
  accountId: string,
  window: DashboardWindow,
): Promise<NextResponse> {
  try {
    const [accountRow] = await sql<AggregateAccountRow[]>`
      SELECT subscription_status, past_due_at, trial_ends_at, flags, stripe_customer_id
      FROM accounts
      WHERE id = ${accountId}::uuid
    `;
    if (!accountRow) {
      return errorResponse('Account not found', 404);
    }

    const gated = await aggregateSubscriptionResponse(accountRow, accountId, window);
    if (gated) return gated;

    const trialEndsAt = trialEndsAtIso(accountRow.subscription_status, accountRow.trial_ends_at);
    const data = await getAggregateDashboardData(sql, accountId, window);
    return jsonResponse({ ...data, trialEndsAt });
  } catch (error) {
    reportCaughtError('api/dashboard', error, { accountId, scope: 'aggregate' });
    return errorResponse('Failed to fetch aggregate dashboard data', 500);
  }
}

// scope=<locationId> (or session default): per-location dashboard data with IDOR
// ownership check and archived/not-found fallback to the account's primary.
async function handlePerLocationDashboard(
  locationId: string,
  accountId: string,
  window: DashboardWindow,
): Promise<NextResponse> {
  // Validate the scope/location id BEFORE the DB read so a malformed
  // client-supplied `?scope=` value produces a controlled 400, not a
  // Postgres `::uuid` cast error surfaced as a 500.
  if (!isValidUuid(locationId)) {
    return errorResponse('Invalid scope: location must be a valid UUID', 400);
  }

  try {
    // IDOR protection: verify the location belongs to the authenticated user's account.
    // getLocationById fetches the row via service-role SQL (bypasses RLS), so we must
    // explicitly check account ownership before returning any data.
    const location = await getLocationById(locationId);

    if (!location) {
      // Location not found — fall back to primary, else 404.
      const fallback = await fallbackToPrimary(accountId, window, 'location_not_found');
      return fallback ?? errorResponse('Business not found', 404);
    }

    if (location.account_id !== accountId) {
      // IDOR attempt: location exists but belongs to a different account
      return errorResponse('Not authorized to access this location', 403);
    }

    if (location.archived_at !== null) {
      // Location is archived — fall back to a different primary, else 404.
      const fallback = await fallbackToPrimary(accountId, window, 'location_archived', locationId);
      return fallback ?? errorResponse('No active location available', 404);
    }

    // Location is active and owned — fetch its data normally
    return fetchPerLocationData(locationId, accountId, window);
  } catch (error) {
    if (error instanceof BusinessNotFoundError) {
      return errorResponse('Business not found', 404);
    }
    reportCaughtError('api/dashboard', error, { accountId, locationId });
    return errorResponse('Failed to fetch dashboard data', 500);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;
  const accountId = owner.accountId;

  // VAL-DASH-024 (`scope`) + #403 (`window`): resolve the scope policy and the
  // validated/clamped time-range in one shared step (the untrusted window never
  // reaches a service / SQL un-clamped).
  const { window, scopePolicy } = resolveDashboardRequest(request, owner.user.locationId);

  if (scopePolicy.mode === 'aggregate') {
    return handleAggregateDashboard(accountId, window);
  }

  const locationId = scopePolicy.locationId;
  if (!locationId) {
    return errorResponse('No business associated with this account', 403);
  }

  return handlePerLocationDashboard(locationId, accountId, window);
}
