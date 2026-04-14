import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { sql } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/payment-success?session_id=cs_test_...
 *
 * Looks up the business that was activated by a Stripe checkout session.
 * The Stripe webhook writes the event to inbound_events; we match by
 * client_reference_id inside the payload. Returns 404 if the webhook
 * has not processed yet — the client retries with exponential backoff.
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

  // Not found yet — webhook may still be processing
  return NextResponse.json({ error: 'Business not found yet' }, { status: 404 });
}
