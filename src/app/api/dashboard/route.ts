import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { buildPaymentLinkUrl } from '@/lib/payments/payment-link';
import {
  getActiveDashboardData,
  BusinessNotFoundError,
} from '@/lib/dashboard/service';

export const dynamic = 'force-dynamic';

export type {
  DashboardData,
  DashboardDataActive,
  DashboardSettings,
} from '@/lib/dashboard/types';


/** All dashboard responses use no-store headers — owner-specific data. */
function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
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

  if (!user.locationId) {
    return jsonResponse({ error: 'No business associated with this account' }, 403);
  }

  const businessId = user.locationId;

  try {
    // Cheap pre-query: determine subscription status + onboarding state
    // before running the 8 heavy queries.
    const [subRow] = await sql<{
      name: string;
      subscription_status: string;
      subscription_tier: string;
      owner_email: string;
      onboarded_by: string | null;
      place_id_verified: boolean;
      google_maps_url: string | null;
    }[]>`
      SELECT name, subscription_status, subscription_tier, owner_email, onboarded_by,
             place_id_verified, google_maps_url
      FROM businesses WHERE id = ${businessId}
    `;
    if (!subRow) {
      return jsonResponse({ error: 'Business not found' }, 404);
    }

    if (subRow.subscription_status === SubscriptionStatus.PENDING_PAYMENT) {
      // Admin-onboarded businesses should NOT see the self-serve payment CTA —
      // they already have a handoff path via the partner. Showing the payment
      // link here would risk a double-charge if the partner's flow used a
      // different price point or coupon.
      if (subRow.onboarded_by !== null) {
        return jsonResponse({
          subscriptionStatus: 'pending_payment_admin_handoff',
          businessId,
          businessName: subRow.name,
        });
      }
      const tier: 'founding' | 'standard' =
        subRow.subscription_tier === 'founding' ||
        subRow.subscription_tier === 'standard'
          ? subRow.subscription_tier
          : 'standard';
      const paymentUrl = buildPaymentLinkUrl(tier, businessId, subRow.owner_email);
      return jsonResponse({
        subscriptionStatus: 'pending_payment',
        businessId,
        businessName: subRow.name,
        paymentUrl,
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
        businessId,
        businessName: subRow.name,
      });
    }

    const data = await getActiveDashboardData(businessId);
    return jsonResponse(data);
  } catch (error) {
    if (error instanceof BusinessNotFoundError) {
      return jsonResponse({ error: 'Business not found' }, 404);
    }
    console.error('[api/dashboard] Failed to fetch dashboard data:', error);
    return jsonResponse({ error: 'Failed to fetch dashboard data' }, 500);
  }
}
