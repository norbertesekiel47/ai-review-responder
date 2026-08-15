import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { getIpKey } from '@/lib/shared/request-ip';
import { isPlaceId } from '@/lib/reviews/url-parser';
import { fetchBusinessDetails } from '@/lib/reviews/serpapi-prefill';
import {
  SubscriptionStatus,
  subscriptionGrantsFullAccess,
} from '@/lib/shared/subscription-status';

// ── Documented invariant exception ───────────────────────────────────
// CLAUDE.md invariant: "Vercel serves UI only. All SLA-critical compute
// runs on Railway." This route makes an outbound SerpAPI call from a
// Vercel serverless function. It is now the ONLY SerpAPI prefill route: the
// admin twin at `src/app/api/admin/businesses/prefill/route.ts` was deleted
// with the admin form's Place capture (admin-invite-funnel), so the shared
// justification lives here:
//   1. The call is user-triggered (the wizard's PlaceAutocomplete fires
//      it on selection; no automation).
//   2. The wizard needs sub-second feedback to fill the form.
//   3. `fetchBusinessDetails` enforces a 2s timeout (SERPAPI_TIMEOUT_MS).
//   4. Two strict 10/min rate limits (per IP and per auth id, Redis-down
//      → 503) cap SerpAPI spend even under malicious traffic.
//   5. Costs land in `api_costs` (business_id=NULL) on every call,
//      including timeouts/errors.
//
// How it differs from the deleted admin twin it was modelled on:
//   - Auth: an authenticated OWNER whose Account is still pre-activation
//     (`pending_payment`). This route used to be deliberately
//     unauthenticated, gated only by `SELF_SERVE_SIGNUP_ENABLED` + a
//     per-IP limit. That flag now means only "strangers may mint
//     accounts" (see
//     `docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`),
//     and dropping it without adding auth would have left a
//     SerpAPI-billed endpoint permanently public. The session IS the
//     gate now.
//   - Rate-limit keys: BOTH the pre-existing per-IP key and a per-auth-id
//     key carried over from that admin route, so one owner cannot rotate
//     IPs to multiply SerpAPI spend.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

interface PrefillGuardRow {
  subscription_status: string;
}

/**
 * One strict 10/min window, fail-closed. Returns the rejecting response, or
 * `null` when the caller may proceed.
 *
 * Two callers below — per-IP and per-auth-id — differ ONLY in their key, so
 * they shared a byte-identical body until this was extracted. Both bounds are
 * load-bearing and neither may be dropped: the per-IP cap misses one owner
 * rotating egress IPs (mobile NAT, VPN), and the per-auth-id cap misses a
 * distributed pool of sessions. `strict: true` means a Redis outage returns 503
 * rather than silently uncapping a SerpAPI-billed endpoint.
 */
async function enforcePrefillRateLimit(key: string): Promise<NextResponse | null> {
  try {
    const { allowed } = await checkRateLimit(key, 10, 60, { strict: true });
    if (allowed) return null;
    return NextResponse.json(
      { error: 'Rate limit exceeded — try again in a minute' },
      { status: 429, headers: NO_STORE },
    );
  } catch {
    return NextResponse.json(
      { error: 'Prefill temporarily unavailable' },
      { status: 503, headers: NO_STORE },
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Authenticated session via cookie-bound anon client. setAll is a
  //    no-op — this is a read-only lookup and never rewrites cookies.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll() {
          // Read-only.
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: NO_STORE },
    );
  }

  // 2. Validate query param before the DB read — a malformed request
  //    should not cost a round trip.
  const placeId = request.nextUrl.searchParams.get('place_id');
  if (!placeId) {
    return NextResponse.json(
      { error: 'place_id query param is required' },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!isPlaceId(placeId)) {
    return NextResponse.json(
      { error: 'place_id is not a valid Google Place ID' },
      { status: 400, headers: NO_STORE },
    );
  }

  // 3. Owner + still-walking-the-funnel state. Owner-only filter at the
  //    SQL boundary (proxy does not gate `/api/signup/*` on role), so an
  //    admin or sales_partner session reads as "no row" → 404. The state
  //    check keeps SerpAPI spend scoped to accounts actually walking the
  //    funnel — but the funnel does NOT end at payment. `StepLocation` in
  //    the wizard (`/onboarding/business`) is this route's other caller,
  //    and **the wizard is reached POST-payment** (Funnel entry: full
  //    access + wizard incomplete → `/onboarding/business`). A
  //    `pending_payment`-only guard therefore 403s the wizard, whose
  //    caller soft-swallows `!res.ok` — category/website prefill would
  //    silently die for every owner in the non-demo wizard, which is the
  //    production shape while `ONBOARDING_DEMO_ENABLED` is off, and for
  //    every card-up-front trial. Allowed: `pending_payment` (demo lane)
  //    plus full access (wizard). Everything else — `cancelled`,
  //    `past_due`, `pending_payment`'s post-cancellation cousins — has no
  //    business spending SerpAPI credits on a funnel it is not in.
  const [row] = await sql<PrefillGuardRow[]>`
    SELECT a.subscription_status
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    WHERE u.auth_id = ${user.id}
      AND u.role = 'owner'
    LIMIT 1
  `;
  if (!row) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: NO_STORE },
    );
  }
  const inFunnel =
    row.subscription_status === SubscriptionStatus.PENDING_PAYMENT ||
    subscriptionGrantsFullAccess(row.subscription_status);
  if (!inFunnel) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: NO_STORE },
    );
  }

  // 4. Strict per-IP rate limit. Redis-down fails closed with 503 so a
  //    cache outage cannot bypass the SerpAPI spend cap.
  const ipLimited = await enforcePrefillRateLimit(getIpKey(request, 'signup-prefill'));
  if (ipLimited) return ipLimited;

  // 5. Strict per-auth-id rate limit, mirroring the admin prefill route.
  //    The per-IP cap alone lets one owner behind rotating egress IPs
  //    (mobile NAT, VPN) spend uncapped; this one is the identity-scoped
  //    ceiling. Same fail-closed posture.
  const ownerLimited = await enforcePrefillRateLimit(`prefill:minute:${user.id}`);
  if (ownerLimited) return ownerLimited;

  // 6. Fetch prefill — never throws; worst case returns all-null.
  const prefill = await fetchBusinessDetails(sql, placeId);

  return NextResponse.json(prefill, { status: 200, headers: NO_STORE });
}
