import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { OnboardingStartSchema } from '@/lib/shared/schemas';
import { extractPlaceId } from '@/lib/reviews/url-parser';
import type { ValidatePlaceIdPayload } from '@/lib/shared/worker-types';
import { reserveOnboardingDemoBudget, CostCeilingExceeded } from '@/lib/costs/onboarding-demo-cost-guard';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { PLACEHOLDER_BUSINESS_NAME } from '@/lib/onboarding/create-business';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

interface BizRow {
  id: string;
  account_id: string;
  user_id: string;
  subscription_status: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
}

// Subset of BizRow for the FOR UPDATE re-read inside the transaction.
// subscription_status is NOT re-checked inside the tx — the outer query
// already gates on it.
interface ForUpdateRow {
  id: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.ONBOARDING_DEMO_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
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

  const [bizRow] = await sql<BizRow[]>`
    SELECT b.id, a.id AS account_id, u.id AS user_id, a.subscription_status, b.place_id_verified, b.google_maps_url
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
      AND u.role = 'owner'
    LIMIT 1
  `;
  if (!bizRow) {
    return NextResponse.json({ error: 'account_incomplete' }, { status: 404, headers: NO_STORE });
  }

  if (bizRow.subscription_status !== SubscriptionStatus.PENDING_PAYMENT) {
    return NextResponse.json(
      { error: 'subscription_inactive', subscriptionStatus: bizRow.subscription_status },
      { status: 409, headers: NO_STORE },
    );
  }

  // Idempotent: redirect to demo page if already started
  if (bizRow.place_id_verified || bizRow.google_maps_url) {
    return NextResponse.json({ redirectTo: '/onboarding/demo', demoQueued: false }, { status: 200, headers: NO_STORE });
  }

  // Outer rate limit: 10/auth-id/hour
  try {
    const rl = await checkRateLimit(`onboarding-start:auth:${user.id}`, 10, 3600, { strict: true });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
    }
  } catch (err) {
    console.error('[api/onboarding/start] rate-limit strict failure:', err);
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400, headers: NO_STORE });
  }
  const parsed = OnboardingStartSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400, headers: NO_STORE });
  }
  const data = parsed.data;

  // Demo-specific rate limits
  const ipKey = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const userRateLimitKey = `onboarding-demo:user:${user.id}`;
  const ipRateLimitKey = `onboarding-demo:ip:${ipKey}`;
  const globalRateLimitKey = `onboarding-demo:global`;

  let demoBlocked = false;
  let blockReason: 'cost_ceiling' | 'rate_limit' | null = null;

  try {
    const userRl = await checkRateLimit(userRateLimitKey, 3, 86400, { strict: true });
    const ipRl = await checkRateLimit(ipRateLimitKey, 5, 86400, { strict: true });
    const globalRl = await checkRateLimit(globalRateLimitKey, 200, 3600, { strict: true });

    if (!userRl.allowed || !ipRl.allowed || !globalRl.allowed) {
      demoBlocked = true;
      blockReason = 'rate_limit';
    }
  } catch (err) {
    console.error('[api/onboarding/start] demo rate-limit check failed:', err);
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503, headers: NO_STORE });
  }

  let cleanupReservation: (() => Promise<void>) | null = null;
  let reservationDate: string | null = null;
  if (!demoBlocked) {
    try {
      const reservation = await reserveOnboardingDemoBudget();
      cleanupReservation = reservation.release;
      reservationDate = reservation.date;
    } catch (err) {
      if (err instanceof CostCeilingExceeded) {
        demoBlocked = true;
        blockReason = 'cost_ceiling';
      } else {
        console.error('[api/onboarding/start] cost-guard reservation failed:', err);
        return NextResponse.json({ error: 'redis_unavailable' }, { status: 503, headers: NO_STORE });
      }
    }
  }

  // Resolve place id
  let resolvedPlaceId: string | null = null;
  let placeIdVerified = false;
  let validatePayload: ValidatePlaceIdPayload | null = null;
  const correlationId = uuidv7();

  if (data.googlePlaceId) {
    resolvedPlaceId = data.googlePlaceId;
    placeIdVerified = true;
  } else {
    const mapsUrl = data.googleMapsUrl!;
    resolvedPlaceId = extractPlaceId(mapsUrl);
    placeIdVerified = false;
    validatePayload = {
      business_id: bizRow.id,
      google_maps_url: mapsUrl,
      correlation_id: correlationId,
    };
  }

  // Track whether the demo INSERT actually fired inside the tx. The outer
  // closure can't observe a return-from-callback no-op (idempotency loser
  // path or vanished business row), so without this flag we'd return
  // demoQueued:true and leak the 20¢ reservation. Only set to true on the
  // happy path where the demo + outbox row are written.
  let demoInserted = false;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${bizRow.id + ':activation'}))`;

      const [forUpdateRow] = await tx<ForUpdateRow[]>`
        SELECT id, place_id_verified, google_maps_url
        FROM businesses
        WHERE id = ${bizRow.id}::uuid
        FOR UPDATE
      `;
      if (!forUpdateRow) return;
      if (forUpdateRow.place_id_verified || forUpdateRow.google_maps_url) return;

      await tx`
        UPDATE businesses
        SET
          name = ${data.businessName},
          category = ${data.prefilledCategory ?? null},
          google_place_id = ${resolvedPlaceId},
          place_id_verified = ${placeIdVerified},
          google_maps_url = ${data.googleMapsUrl ?? null},
          website = ${data.prefilledWebsite ?? null},
          updated_at = NOW()
        WHERE id = ${bizRow.id}::uuid
      `;

      await tx`
        UPDATE accounts
        SET display_name = ${data.businessName}, updated_at = NOW()
        WHERE id = ${bizRow.account_id}::uuid
          AND display_name = ${PLACEHOLDER_BUSINESS_NAME}
      `;

      if (validatePayload) {
        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT ${uuidv7()}::uuid, 'validate_place_id', 'business', ${bizRow.id}::uuid, ${jsonb(validatePayload)}, 'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.aggregate_id = ${bizRow.id}::uuid
              AND jo.topic = 'validate_place_id'
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
          )
        `;
      }

      if (!demoBlocked) {
        const demoId = uuidv7();
        const outboxId = uuidv7();

        await tx`
          INSERT INTO onboarding_demos (
            id, user_id, business_id, business_name, category,
            google_place_id, google_maps_url, generation_status,
            correlation_id, created_at, updated_at
          ) VALUES (
            ${demoId}, ${bizRow.user_id}::uuid, ${bizRow.id}::uuid,
            ${data.businessName}, ${data.prefilledCategory ?? null},
            ${resolvedPlaceId}, ${data.googleMapsUrl ?? null},
            'queued', ${correlationId}, NOW(), NOW()
          )
        `;

        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${outboxId}, 'onboarding_demo_response', 'onboarding_demo', ${demoId}::uuid,
            ${jsonb({
              demoId,
              googlePlaceId: resolvedPlaceId,
              businessName: data.businessName,
              category: data.prefilledCategory ?? undefined,
              googleMapsUrl: data.googleMapsUrl ?? undefined,
              correlation_id: correlationId,
              outbox_id: outboxId,
              cost_reservation_date: reservationDate ?? undefined,
            })},
            'pending'
          )
        `;
        demoInserted = true;
      }
    });
  } catch (err) {
    if (cleanupReservation) {
      try { await cleanupReservation(); } catch { /* ignore */ }
    }
    console.error('[api/onboarding/start] transaction failed:', err);
    return NextResponse.json({ error: 'internal' }, { status: 500, headers: NO_STORE });
  }

  // Idempotency-loser path: tx committed without inserting a demo (another
  // /start submission won the FOR UPDATE race, OR the business row vanished).
  // Release the reservation we made earlier so we don't leak 20¢ per loser,
  // and report demoQueued:false so the client doesn't poll for a demo that
  // doesn't exist.
  if (!demoBlocked && !demoInserted && cleanupReservation) {
    try { await cleanupReservation(); } catch { /* ignore */ }
  }

  return NextResponse.json(
    {
      redirectTo: '/onboarding/demo',
      demoQueued: !demoBlocked && demoInserted,
      reason: blockReason,
    },
    { status: 200, headers: NO_STORE },
  );
}
