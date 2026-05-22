import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';

export const dynamic = 'force-dynamic';

type SignupStatusRow = {
  account_id: string;
  subscription_status: string;
  role: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
  subscription_activated_at: Date | null;
  updated_at: Date;
};

function getCheckoutSessionId(req: NextRequest): string | null {
  const value =
    req.nextUrl.searchParams.get('session_id') ??
    req.nextUrl.searchParams.get('checkout_session_id');
  if (!value) return null;
  if (!value.startsWith('cs_') || value.length > 255) return null;
  return value;
}

async function enqueueCheckoutSessionReconciliation(
  sessionId: string,
  accountId: string,
): Promise<void> {
  const correlationId = uuidv7();
  const payload = {
    account_id: accountId,
    checkout_session_id: sessionId,
    correlation_id: correlationId,
  };
  const lockKey = `stripe_checkout_session_reconcile:${accountId}:${sessionId}`;

  await sql.begin(async (tx) => {
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtext(${lockKey})
      )
    `;

    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, status
      )
      SELECT
        ${uuidv7()}::uuid,
        ${QUEUE_NAMES.STRIPE_CHECKOUT_RECONCILE},
        'account',
        ${accountId}::uuid,
        ${jsonb(payload)},
        'pending'
      WHERE NOT EXISTS (
        SELECT 1
        FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.STRIPE_CHECKOUT_RECONCILE}
          AND jo.aggregate_id = ${accountId}::uuid
          AND jo.payload->>'checkout_session_id' = ${sessionId}
          AND (
            jo.status IN ('pending', 'dispatching', 'dispatched')
            OR jo.created_at > NOW() - INTERVAL '10 minutes'
          )
      )
    `;
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // 1. Feature flag — hide the route entirely when off.
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // 2. Read session via cookie-bound anon client. setAll is a no-op — this
  //    is a read-only polling endpoint and never rewrites session cookies.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Read-only — no cookie refresh needed on this polling endpoint.
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 3. Non-strict rate limit. Normal client polls every 2-30s, well under 30/min.
  //    Only pathological runaway loops get 429'd. Soft-fail if Redis is down so
  //    a cache outage doesn't break the payment-success poller.
  const rl = await checkRateLimit(
    `signup-status:auth:${user.id}`,
    30,
    60,
  ).catch(() => ({ allowed: true, remaining: 30 }));
  if (!rl.allowed) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  // 4. Service-role sql query — join users + businesses by auth_id and
  //    require owner role before returning owner self-service state.
  //    Explicit auth_id scoping: there is no owner-scoped RLS on businesses,
  //    so we enforce the scope in the WHERE clause.
  //
  //    `business_onboarded` semantics depend on ONBOARDING_DEMO_ENABLED:
  //
  //    - Legacy (flag OFF): true once the 3-step wizard supplied a verified
  //      Place ID or Google Maps URL. Both fields are NULL/false on the
  //      placeholder row written at signup, so a verified value reliably
  //      means "wizard ran".
  //
  //    - PR #2 (flag ON): /onboarding/start writes place_id_verified=true
  //      BEFORE Stripe. The legacy definition would mark every paying user
  //      "onboarded" as soon as Stripe fires — pulling them straight to
  //      /dashboard and skipping the post-pay 2-step Profile/Voice wizard.
  //      We need a "wizard ran post-Stripe" signal instead. Proxy: the
  //      post-pay wizard's UPDATE bumps `updated_at`, while the Stripe
  //      webhook sets `subscription_activated_at` and `updated_at` together.
  //      So `updated_at > subscription_activated_at + small buffer` indicates
  //      a write strictly after Stripe — almost always the wizard.
  //
  //      Phase 2 follow-up: add an explicit `business_profile_completed_at`
  //      column and migrate to that. The proxy can false-positive if the
  //      PlaceIdValidationWorker (URL-paste path) lands its UPDATE after
  //      Stripe; for the autocomplete path (pre-verified Place ID, no
  //      validation worker enqueued) the proxy is exact.
  const demoFlowEnabled = process.env.ONBOARDING_DEMO_ENABLED === 'true';
  const ownerRole = 'owner';
  const [row] = await sql<SignupStatusRow[]>`
    SELECT a.id AS account_id, a.subscription_status, u.role,
           b.place_id_verified, b.google_maps_url,
           a.subscription_activated_at, b.updated_at
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
      AND u.role = ${ownerRole}
    LIMIT 1
  `;

  if (!row || row.role !== ownerRole) {
    // Signup flow not yet complete (no users row provisioned yet) or
    // business not attached, or this is not an owner self-service user.
    return NextResponse.json({ error: 'account_incomplete' }, { status: 404 });
  }

  const subscriptionStatus = row.subscription_status;
  const subscriptionActivatedAt = row.subscription_activated_at;
  const checkoutSessionId = getCheckoutSessionId(req);
  if (
    subscriptionStatus !== SubscriptionStatus.ACTIVE &&
    checkoutSessionId !== null
  ) {
    try {
      await enqueueCheckoutSessionReconciliation(
        checkoutSessionId,
        row.account_id,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[signup-status] Checkout Session reconciliation enqueue failed for account=${row.account_id}: ${message}`,
      );
    }
  }

  // 5. Compute business_onboarded based on the active flow. Done in JS
  //    rather than a SQL CASE so the test mocks (single tagged-template
  //    call, plain row return) stay simple — and the proxy logic is easier
  //    to reason about co-located with the comment above.
  const businessOnboarded = demoFlowEnabled
    ? subscriptionStatus === SubscriptionStatus.ACTIVE
      && subscriptionActivatedAt !== null
      && new Date(row.updated_at).getTime()
         > new Date(subscriptionActivatedAt).getTime() + 2_000
    : row.place_id_verified || row.google_maps_url !== null;

  // 6. Return subscription status + role + businessOnboarded. The
  //    /onboarding/payment-success page polls with exponential backoff
  //    (2s → 30s, up to 5 min) and redirects to /onboarding/business when
  //    status === 'active' && !businessOnboarded, otherwise to /dashboard.
  return NextResponse.json(
    {
      subscriptionStatus,
      role: row.role,
      businessOnboarded,
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store, private' },
    },
  );
}
