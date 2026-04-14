import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { sql } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/payment-success?session_id=cs_test_...
 *
 * Looks up the business that was activated by a Stripe checkout session.
 * The Stripe webhook writes stripe_customer_id when processing
 * checkout.session.completed. We look up by that or by matching the
 * most recently activated business (fallback for timing gaps).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sessionId = request.nextUrl.searchParams.get('session_id');
  if (!sessionId) {
    return NextResponse.json({ error: 'session_id is required' }, { status: 400 });
  }

  // Try to find the business by checking inbound_events for the checkout session
  // The Stripe webhook stores the full event payload in inbound_events
  const [event] = await sql<{ payload: string | Record<string, unknown> }[]>`
    SELECT payload FROM inbound_events
    WHERE source = 'stripe'
      AND event_type = 'checkout.session.completed'
      AND payload->>'id' = ${sessionId}
    LIMIT 1
  `;

  if (event) {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    const data = (payload as Record<string, unknown>).data as Record<string, unknown> | undefined;
    const sessionObj = data?.object as Record<string, unknown> | undefined;
    const businessId = sessionObj?.client_reference_id as string | undefined;

    if (businessId) {
      // Verify the business exists and is active
      const [biz] = await sql<{ id: string; subscription_status: string }[]>`
        SELECT id, subscription_status FROM businesses WHERE id = ${businessId}::uuid
      `;
      if (biz) {
        return NextResponse.json({
          businessId: biz.id,
          subscriptionStatus: biz.subscription_status,
        });
      }
    }
  }

  // Fallback: The webhook event may reference the session's Stripe event ID,
  // not the session ID directly. Check by looking for recent activations.
  // Look for the most recently activated business (within last 5 minutes)
  const [recentBiz] = await sql<{ id: string }[]>`
    SELECT id FROM businesses
    WHERE subscription_status = 'active'
      AND updated_at > NOW() - INTERVAL '5 minutes'
    ORDER BY updated_at DESC
    LIMIT 1
  `;

  if (recentBiz) {
    return NextResponse.json({ businessId: recentBiz.id, subscriptionStatus: 'active' });
  }

  // Not found yet — webhook may still be processing
  return NextResponse.json({ error: 'Business not found yet' }, { status: 404 });
}
