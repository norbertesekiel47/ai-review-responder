import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  getActiveDashboardData,
  BusinessNotFoundError,
} from '@/lib/dashboard/service';
import { getAggregateDashboardData } from '@/lib/dashboard/aggregate-service';
import { getLocationById } from '@/lib/locations/repo';

export const dynamic = 'force-dynamic';

export type {
  DashboardData,
  DashboardDataActive,
  DashboardSettings,
  AggregateDashboardData,
} from '@/lib/dashboard/types';


/** All dashboard responses use no-store headers — owner-specific data. */
function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
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
 * @param fallback    If provided, a scopeFallback indicator to include in the response.
 */
async function fetchPerLocationData(
  locationId: string,
  accountId: string,
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
  }[]>`
    SELECT b.name, a.subscription_status, a.subscription_tier,
           b.owner_email, b.onboarded_by,
           b.place_id_verified, b.google_maps_url,
           b.archived_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${locationId}
      AND b.account_id = ${accountId}::uuid
  `;

  if (!subRow) {
    return jsonResponse({ error: 'Business not found' }, 404);
  }

  // VAL-DASH-029: If the fallback location itself is archived, we're stuck
  if (subRow.archived_at !== null) {
    return jsonResponse({ error: 'No active location available' }, 404);
  }

  if (subRow.subscription_status === SubscriptionStatus.PENDING_PAYMENT) {
    // Admin-onboarded businesses should NOT see the self-serve payment CTA —
    // they already have a handoff path via the partner. Showing the payment
    // link here would risk a double-charge if the partner's flow used a
    // different price point or coupon.
    if (subRow.onboarded_by !== null) {
      return jsonResponse({
        subscriptionStatus: 'pending_payment_admin_handoff',
        locationId,
        businessName: subRow.name,
      });
    }
    // Self-serve owners with pending_payment should be directed to
    // /onboarding/pay where the PlanPickerClient creates a Checkout
    // Session via /api/onboarding/select-plan.
    // This replaces the old Payment Link URL flow.
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const paymentUrl = `${baseUrl}/onboarding/pay`;
    return jsonResponse({
      subscriptionStatus: 'pending_payment',
      locationId,
      businessName: subRow.name,
      paymentUrl,
    });
  }

  // VAL-CROSS-011: Cancelled account — 30-day grace period for read access
  if (subRow.subscription_status === SubscriptionStatus.CANCELLED) {
    // Compute grace period end date (30 days from subscription_activated_at or cancellation)
    const [cancelledRow] = await sql<{
      subscription_activated_at: Date | null;
    }[]>`
      SELECT subscription_activated_at FROM accounts WHERE id = ${accountId}::uuid
    `;
    const activatedAt = cancelledRow?.subscription_activated_at;
    // Grace period: 30 days from the cancellation event.
    // Since we don't have a cancelled_at column, we use subscription_activated_at
    // as a proxy — in practice, the CancellationGracePoller tracks this.
    // For now, report read access as true (within grace period).
    const gracePeriodEnd = activatedAt
      ? new Date(new Date(activatedAt).getTime() + 30 * 86_400_000)
      : null;
    const readAccess = gracePeriodEnd
      ? gracePeriodEnd > new Date()
      : true; // default to read access if we can't determine
    return jsonResponse({
      subscriptionStatus: 'cancelled',
      businessName: subRow.name,
      gracePeriodEndDate: gracePeriodEnd?.toISOString() ?? null,
      readAccess,
    });
  }

  // VAL-CROSS-012: Past-due account — payment warning, features continue during grace
  if (subRow.subscription_status === SubscriptionStatus.PAST_DUE) {
    // Generate a billing portal URL if the account has a Stripe customer ID
    const [stripeRow] = await sql<{
      stripe_customer_id: string | null;
    }[]>`
      SELECT stripe_customer_id FROM accounts WHERE id = ${accountId}::uuid
    `;
    const billingPortalUrl = stripeRow?.stripe_customer_id
      ? `/api/billing/portal`
      : null;
    return jsonResponse({
      subscriptionStatus: 'past_due',
      businessName: subRow.name,
      billingPortalUrl,
    });
  }

  // Active subscription but the owner skipped or never reached the
  // /onboarding/business wizard (e.g. bookmarked /dashboard from earlier
  // or closed the tab during the post-payment redirect). Surface a
  // CTA-only screen instead of the empty-state dashboard so they have
  // an obvious next action.
  if (
    subRow.subscription_status === SubscriptionStatus.ACTIVE &&
    !subRow.place_id_verified &&
    subRow.google_maps_url === null
  ) {
    return jsonResponse({
      subscriptionStatus: 'active_pending_business',
      locationId,
      businessName: subRow.name,
    });
  }

  const data = await getActiveDashboardData(locationId);

  // VAL-DASH-029: Attach scopeFallback indicator if a fallback occurred
  if (fallback) {
    return jsonResponse({ ...data, ...fallback });
  }

  return jsonResponse(data);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse({ error: err.message }, err.statusCode);
    }
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (!user.accountId) {
    return jsonResponse({ error: 'No account associated with this user' }, 403);
  }

  const accountId = user.accountId;

  // VAL-DASH-024: Accept `scope` query parameter
  // scope=all → aggregate dashboard data
  // scope=<locationId> → per-location dashboard data
  // no scope → use the user's current location from session/cookie
  const scopeParam = request.nextUrl.searchParams.get('scope');
  const multiLocationEnabled = process.env.MULTI_LOCATION_ENABLED === 'true';

  // Aggregate mode: scope=all
  if (multiLocationEnabled && scopeParam === 'all') {
    try {
      // Verify account subscription status before returning aggregate data
      const [accountRow] = await sql<{
        subscription_status: string;
      }[]>`
        SELECT subscription_status FROM accounts WHERE id = ${accountId}::uuid
      `;
      if (!accountRow) {
        return jsonResponse({ error: 'Account not found' }, 404);
      }

      if (accountRow.subscription_status === SubscriptionStatus.PENDING_PAYMENT) {
        return jsonResponse({
          subscriptionStatus: 'pending_payment',
          businessName: 'Account',
          paymentUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/onboarding/pay`,
        });
      }

      // VAL-CROSS-011: Cancelled account in aggregate mode
      if (accountRow.subscription_status === SubscriptionStatus.CANCELLED) {
        const [cancelledRow] = await sql<{
          subscription_activated_at: Date | null;
        }[]>`
          SELECT subscription_activated_at FROM accounts WHERE id = ${accountId}::uuid
        `;
        const activatedAt = cancelledRow?.subscription_activated_at;
        const gracePeriodEnd = activatedAt
          ? new Date(new Date(activatedAt).getTime() + 30 * 86_400_000)
          : null;
        const readAccess = gracePeriodEnd
          ? gracePeriodEnd > new Date()
          : true;
        return jsonResponse({
          subscriptionStatus: 'cancelled',
          businessName: 'Account',
          gracePeriodEndDate: gracePeriodEnd?.toISOString() ?? null,
          readAccess,
        });
      }

      // VAL-CROSS-012: Past-due account in aggregate mode
      if (accountRow.subscription_status === SubscriptionStatus.PAST_DUE) {
        const [stripeRow] = await sql<{
          stripe_customer_id: string | null;
        }[]>`
          SELECT stripe_customer_id FROM accounts WHERE id = ${accountId}::uuid
        `;
        const billingPortalUrl = stripeRow?.stripe_customer_id
          ? `/api/billing/portal`
          : null;
        return jsonResponse({
          subscriptionStatus: 'past_due',
          businessName: 'Account',
          billingPortalUrl,
        });
      }

      if (accountRow.subscription_status !== SubscriptionStatus.ACTIVE) {
        return jsonResponse({
          subscriptionStatus: accountRow.subscription_status,
        });
      }

      const data = await getAggregateDashboardData(accountId);
      return jsonResponse(data);
    } catch (error) {
      console.error('[api/dashboard] Failed to fetch aggregate data:', error);
      return jsonResponse({ error: 'Failed to fetch aggregate dashboard data' }, 500);
    }
  }

  // Per-location mode: use scope parameter or fall back to user's current location
  const locationId = (scopeParam && scopeParam !== 'all')
    ? scopeParam
    : user.locationId;

  if (!locationId) {
    return jsonResponse({ error: 'No business associated with this account' }, 403);
  }

  try {
    // IDOR protection: verify the location belongs to the authenticated user's account.
    // getLocationById fetches the row via service-role SQL (bypasses RLS), so we must
    // explicitly check account ownership before returning any data.
    const location = await getLocationById(locationId);

    if (!location) {
      // Location not found — fall back to primary
      const primary = await getPrimaryLocationId(accountId);
      if (primary) {
        return fetchPerLocationData(primary, accountId, {
          scopeFallback: { reason: 'location_not_found', fallbackLocationId: primary },
        });
      }
      return jsonResponse({ error: 'Business not found' }, 404);
    }

    if (location.account_id !== accountId) {
      // IDOR attempt: location exists but belongs to a different account
      return jsonResponse({ error: 'Not authorized to access this location' }, 403);
    }

    if (location.archived_at !== null) {
      // Location is archived — fall back to primary
      const primary = await getPrimaryLocationId(accountId);
      if (primary && primary !== locationId) {
        return fetchPerLocationData(primary, accountId, {
          scopeFallback: { reason: 'location_archived', fallbackLocationId: primary },
        });
      }
      // Primary itself archived or same — return error
      return jsonResponse({ error: 'No active location available' }, 404);
    }

    // Location is active and owned — fetch its data normally
    return fetchPerLocationData(locationId, accountId);
  } catch (error) {
    if (error instanceof BusinessNotFoundError) {
      return jsonResponse({ error: 'Business not found' }, 404);
    }
    console.error('[api/dashboard] Failed to fetch dashboard data:', error);
    return jsonResponse({ error: 'Failed to fetch dashboard data' }, 500);
  }
}
