import { NextRequest, NextResponse } from 'next/server';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { createServerClient } from '@supabase/ssr';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { OnboardingStartSchema } from '@/lib/shared/schemas';
import { extractPlaceId } from '@/lib/reviews/url-parser';
import type { ValidatePlaceIdPayload } from '@/lib/shared/worker-types';
import { reserveOnboardingDemoBudget, CostCeilingExceeded } from '@/lib/costs/onboarding-demo-cost-guard';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { PLACEHOLDER_BUSINESS_NAME } from '@/lib/onboarding/create-business';
import { onboardingDemoEnabled } from '@/lib/onboarding/flags';
import { botIdBlockResponse } from '@/lib/security/botid';
import type postgres from 'postgres';
import { enqueueValidatePlaceId } from '@/lib/shared/job-outbox-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

type TxClient = postgres.TransactionSql;
type OnboardingStartInput = ReturnType<typeof OnboardingStartSchema.parse>;

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

// Resolve the place id from the validated body. A direct googlePlaceId is
// trusted (verified); a Maps URL is parsed and queued for async validation.
function resolvePlaceId(
  data: OnboardingStartInput,
  bizId: string,
  correlationId: string,
): {
  resolvedPlaceId: string | null;
  placeIdVerified: boolean;
  validatePayload: ValidatePlaceIdPayload | null;
} {
  if (data.googlePlaceId) {
    return { resolvedPlaceId: data.googlePlaceId, placeIdVerified: true, validatePayload: null };
  }
  const mapsUrl = data.googleMapsUrl!;
  return {
    resolvedPlaceId: extractPlaceId(mapsUrl),
    placeIdVerified: false,
    validatePayload: {
      business_id: bizId,
      google_maps_url: mapsUrl,
      correlation_id: correlationId,
    },
  };
}

interface OnboardingStartTxParams {
  bizRow: BizRow;
  data: OnboardingStartInput;
  resolvedPlaceId: string | null;
  placeIdVerified: boolean;
  validatePayload: ValidatePlaceIdPayload | null;
  demoBlocked: boolean;
  reservationDate: string | null;
  correlationId: string;
}

// The activation transaction: advisory-lock + FOR UPDATE idempotency re-read,
// then the business/account updates, the optional place-id validation outbox,
// and (unless the demo is blocked) the demo row + its outbox.
//
// Returns whether the demo row was actually inserted. The caller relies on this
// to release the cost reservation on the idempotency-loser / vanished-row path
// so we never leak a reservation for a demo that wasn't queued.
async function persistOnboardingStart(tx: TxClient, p: OnboardingStartTxParams): Promise<boolean> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${p.bizRow.id + ':activation'}))`;

  const [forUpdateRow] = await tx<ForUpdateRow[]>`
    SELECT id, place_id_verified, google_maps_url
    FROM businesses
    WHERE id = ${p.bizRow.id}::uuid
    FOR UPDATE
  `;
  if (!forUpdateRow) return false;
  if (forUpdateRow.place_id_verified || forUpdateRow.google_maps_url) return false;

  await tx`
    UPDATE businesses
    SET
      name = ${p.data.businessName},
      category = ${p.data.prefilledCategory ?? null},
      google_place_id = ${p.resolvedPlaceId},
      place_id_verified = ${p.placeIdVerified},
      google_maps_url = ${p.data.googleMapsUrl ?? null},
      website = ${p.data.prefilledWebsite ?? null},
      updated_at = NOW()
    WHERE id = ${p.bizRow.id}::uuid
  `;

  await tx`
    UPDATE accounts
    SET display_name = ${p.data.businessName}, updated_at = NOW()
    WHERE id = ${p.bizRow.account_id}::uuid
      AND display_name = ${PLACEHOLDER_BUSINESS_NAME}
  `;

  if (p.validatePayload) {
    await enqueueValidatePlaceId(tx, {
      businessId: p.bizRow.id,
      googleMapsUrl: p.validatePayload.google_maps_url,
      correlationId: p.validatePayload.correlation_id,
    });
  }

  if (p.demoBlocked) return false;

  const demoId = uuidv7();
  const outboxId = uuidv7();

  await tx`
    INSERT INTO onboarding_demos (
      id, user_id, business_id, business_name, category,
      google_place_id, google_maps_url, generation_status,
      correlation_id, created_at, updated_at
    ) VALUES (
      ${demoId}, ${p.bizRow.user_id}::uuid, ${p.bizRow.id}::uuid,
      ${p.data.businessName}, ${p.data.prefilledCategory ?? null},
      ${p.resolvedPlaceId}, ${p.data.googleMapsUrl ?? null},
      'queued', ${p.correlationId}, NOW(), NOW()
    )
  `;

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId}, ${QUEUE_NAMES.ONBOARDING_DEMO_RESPONSE}, 'onboarding_demo', ${demoId}::uuid,
      ${jsonb({
        demoId,
        googlePlaceId: p.resolvedPlaceId,
        businessName: p.data.businessName,
        category: p.data.prefilledCategory ?? undefined,
        googleMapsUrl: p.data.googleMapsUrl ?? undefined,
        correlation_id: p.correlationId,
        outbox_id: outboxId,
        cost_reservation_date: p.reservationDate ?? undefined,
      })},
      'pending'
    )
  `;
  return true;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!onboardingDemoEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  if (!selfServeSignupEnabled()) {
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

  // Vercel BotID (Deep Analysis) — gate the pre-pay LLM demo behind bot
  // detection. Placed AFTER the auth check on purpose: this route is auth-gated,
  // and Deep Analysis is billed per call, so running it only for an authenticated
  // session (not session-less scripted noise that 401s anyway, and not behind the
  // forgeable same-origin header) avoids paying for Deep on traffic the cheap 401
  // already rejects. Authenticated bots are still checked. Fails open on a BotID
  // infra error.
  const botBlock = await botIdBlockResponse('/api/onboarding/start');
  if (botBlock) return botBlock;

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
    reportCaughtError('api/onboarding/start', err, { reason: 'rate_limit_strict_failure' });
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
    reportCaughtError('api/onboarding/start', err, { reason: 'demo_rate_limit_check_failed' });
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
        reportCaughtError('api/onboarding/start', err, { reason: 'cost_guard_reservation_failed' });
        return NextResponse.json({ error: 'redis_unavailable' }, { status: 503, headers: NO_STORE });
      }
    }
  }

  // Resolve place id
  const correlationId = uuidv7();
  const { resolvedPlaceId, placeIdVerified, validatePayload } = resolvePlaceId(
    data,
    bizRow.id,
    correlationId,
  );

  // Track whether the demo INSERT actually fired inside the tx. The outer
  // closure can't observe a return-from-callback no-op (idempotency loser
  // path or vanished business row), so without this flag we'd return
  // demoQueued:true and leak the 20¢ reservation. Only set to true on the
  // happy path where the demo + outbox row are written.
  let demoInserted = false;
  try {
    await sql.begin(async (tx) => {
      demoInserted = await persistOnboardingStart(tx, {
        bizRow,
        data,
        resolvedPlaceId,
        placeIdVerified,
        validatePayload,
        demoBlocked,
        reservationDate,
        correlationId,
      });
    });
  } catch (err) {
    if (cleanupReservation) {
      try { await cleanupReservation(); } catch { /* ignore */ }
    }
    reportCaughtError('api/onboarding/start', err, { reason: 'transaction_failed', businessId: bizRow.id });
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
