import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export const dynamic = 'force-dynamic';

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

  // 4. Service-role sql query — join users + businesses by auth_id.
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
  const [row] = await sql<
    {
      subscription_status: string;
      role: string;
      place_id_verified: boolean;
      google_maps_url: string | null;
      subscription_activated_at: Date | null;
      updated_at: Date;
    }[]
  >`
    SELECT b.subscription_status, u.role,
           b.place_id_verified, b.google_maps_url,
           b.subscription_activated_at, b.updated_at
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;

  if (!row) {
    // Signup flow not yet complete (no users row provisioned yet) or
    // business not attached — tell the poller to keep waiting.
    return NextResponse.json({ error: 'account_incomplete' }, { status: 404 });
  }

  // 5. Compute business_onboarded based on the active flow. Done in JS
  //    rather than a SQL CASE so the test mocks (single tagged-template
  //    call, plain row return) stay simple — and the proxy logic is easier
  //    to reason about co-located with the comment above.
  const businessOnboarded = demoFlowEnabled
    ? row.subscription_status === 'active'
      && row.subscription_activated_at !== null
      && new Date(row.updated_at).getTime()
         > new Date(row.subscription_activated_at).getTime() + 2_000
    : row.place_id_verified || row.google_maps_url !== null;

  // 6. Return subscription status + role + businessOnboarded. The
  //    /onboarding/payment-success page polls every 2s and redirects to
  //    /onboarding/business when status === 'active' && !businessOnboarded,
  //    otherwise to /dashboard.
  return NextResponse.json(
    {
      subscriptionStatus: row.subscription_status,
      role: row.role,
      businessOnboarded,
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store, private' },
    },
  );
}
