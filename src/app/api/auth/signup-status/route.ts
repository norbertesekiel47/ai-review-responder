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
  //    `business_onboarded` is true once the wizard has either supplied a
  //    verified Place ID OR a Google Maps URL. Both fields are NULL/false
  //    on the placeholder row written at signup.
  const [row] = await sql<
    { subscription_status: string; role: string; business_onboarded: boolean }[]
  >`
    SELECT b.subscription_status, u.role,
           (b.place_id_verified OR b.google_maps_url IS NOT NULL) AS business_onboarded
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

  // 5. Return subscription status + role + businessOnboarded. The
  //    /onboarding/payment-success page polls every 2s and redirects to
  //    /onboarding/business when status === 'active' && !businessOnboarded,
  //    otherwise to /dashboard.
  return NextResponse.json(
    {
      subscriptionStatus: row.subscription_status,
      role: row.role,
      businessOnboarded: row.business_onboarded,
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store, private' },
    },
  );
}
