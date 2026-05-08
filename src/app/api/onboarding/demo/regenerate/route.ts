import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { reserveOnboardingDemoBudget, CostCeilingExceeded } from '@/lib/costs/onboarding-demo-cost-guard';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

interface OwnerRow {
  id: string;
  user_id: string;
  subscription_status: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.ONBOARDING_DEMO_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    throw err;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const [owner] = await sql<OwnerRow[]>`
    SELECT u.id AS user_id, b.id AS id, a.subscription_status
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
      AND u.role = 'owner'
    LIMIT 1
  `;
  if (!owner) {
    return NextResponse.json({ error: 'account_incomplete' }, { status: 404, headers: NO_STORE });
  }

  // Subscription gate: regenerate only meaningful pre-pay. An active owner
  // calling this endpoint would archive their completed demo and enqueue a
  // new one; the worker's inverted subscription guard would then mark it
  // failed (subscription_state_changed), leaving them with no completed demo.
  if (owner.subscription_status !== 'pending_payment') {
    return NextResponse.json(
      { error: 'subscription_inactive', subscriptionStatus: owner.subscription_status },
      { status: 409, headers: NO_STORE },
    );
  }

  // Same 3/24h window as /start
  const userRateLimitKey = `onboarding-demo:user:${user.id}`;
  try {
    const rl = await checkRateLimit(userRateLimitKey, 3, 86400, { strict: true });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
    }
  } catch {
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503, headers: NO_STORE });
  }

  let cleanupReservation: (() => Promise<void>) | null = null;
  let reservationDate: string | null = null;
  try {
    const reservation = await reserveOnboardingDemoBudget();
    cleanupReservation = reservation.release;
    reservationDate = reservation.date;
  } catch (err) {
    if (err instanceof CostCeilingExceeded) {
      return NextResponse.json({ error: 'cost_ceiling' }, { status: 200, headers: NO_STORE });
    }
    return NextResponse.json({ error: 'redis_unavailable' }, { status: 503, headers: NO_STORE });
  }

  const [latestDemo] = await sql<{
    id: string;
    business_name: string;
    category: string | null;
    google_place_id: string | null;
    google_maps_url: string | null;
  }[]>`
    SELECT id, business_name, category, google_place_id, google_maps_url
    FROM onboarding_demos
    WHERE user_id = ${owner.user_id}::uuid
      AND generation_status = 'completed'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!latestDemo) {
    if (cleanupReservation) await cleanupReservation();
    return NextResponse.json({ error: 'no_demo_to_regenerate' }, { status: 409, headers: NO_STORE });
  }

  const correlationId = uuidv7();
  const newDemoId = uuidv7();
  const outboxId = uuidv7();

  try {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE onboarding_demos
        SET generation_status = 'archived', updated_at = NOW()
        WHERE id = ${latestDemo.id}::uuid
      `;

      await tx`
        INSERT INTO onboarding_demos (
          id, user_id, business_id, business_name, category,
          google_place_id, google_maps_url, generation_status,
          correlation_id, created_at, updated_at
        ) VALUES (
          ${newDemoId}, ${owner.user_id}::uuid, ${owner.id}::uuid,
          ${latestDemo.business_name}, ${latestDemo.category},
          ${latestDemo.google_place_id}, ${latestDemo.google_maps_url},
          'queued', ${correlationId}, NOW(), NOW()
        )
      `;

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${outboxId}, 'onboarding_demo_response', 'onboarding_demo', ${newDemoId}::uuid,
          ${jsonb({
            demoId: newDemoId,
            googlePlaceId: latestDemo.google_place_id,
            businessName: latestDemo.business_name,
            category: latestDemo.category ?? undefined,
            googleMapsUrl: latestDemo.google_maps_url ?? undefined,
            correlation_id: correlationId,
            outbox_id: outboxId,
            cost_reservation_date: reservationDate ?? undefined,
          })},
          'pending'
        )
      `;
    });
  } catch (err) {
    if (cleanupReservation) {
      try { await cleanupReservation(); } catch { /* ignore */ }
    }
    console.error('[api/onboarding/demo/regenerate] transaction failed:', err);
    return NextResponse.json({ error: 'internal' }, { status: 500, headers: NO_STORE });
  }

  return NextResponse.json(
    { redirectTo: '/onboarding/demo', demoQueued: true },
    { status: 200, headers: NO_STORE },
  );
}
