import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { getIpKey } from '@/lib/shared/request-ip';
import { isPlaceId } from '@/lib/reviews/url-parser';
import { fetchBusinessDetails } from '@/lib/reviews/serpapi-prefill';

// ── Documented invariant exception ───────────────────────────────────
// CLAUDE.md invariant: "Vercel serves UI only. All SLA-critical compute
// runs on Railway." This route makes an outbound SerpAPI call from a
// Vercel serverless function — same exception that applies to the admin
// prefill route (`src/app/api/admin/businesses/prefill/route.ts`):
//   1. The call is user-triggered (the wizard's PlaceAutocomplete fires
//      it on selection; no automation).
//   2. The wizard needs sub-second feedback to fill the form.
//   3. `fetchBusinessDetails` enforces a 2s timeout (SERPAPI_TIMEOUT_MS).
//   4. A 10/min per-IP strict rate limit (Redis-down → 503) caps SerpAPI
//      spend even under malicious traffic.
//   5. Costs land in `api_costs` (business_id=NULL) on every call,
//      including timeouts/errors.
//
// Structurally mirrors the admin route. Differences:
//   - Auth: none (the wizard caller is owner-authed via cookie, but the
//     prefill itself is just a Place ID lookup; we gate on the same flag
//     that hides the entire signup flow when off).
//   - Rate-limit key: IP-based (`getIpKey(req, 'signup-prefill')`),
//     because the request is owner-context but reaching the wizard
//     already required auth + active subscription elsewhere in the flow.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Feature flag — hide the route entirely when off.
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  // 2. Validate query param.
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

  // 3. Strict per-IP rate limit. Redis-down fails closed with 503 so a
  //    cache outage cannot bypass the SerpAPI spend cap.
  try {
    const { allowed } = await checkRateLimit(
      getIpKey(request, 'signup-prefill'),
      10,
      60,
      { strict: true },
    );
    if (!allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded — try again in a minute' },
        { status: 429, headers: NO_STORE },
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'Prefill temporarily unavailable' },
      { status: 503, headers: NO_STORE },
    );
  }

  // 4. Fetch prefill — never throws; worst case returns all-null.
  const prefill = await fetchBusinessDetails(placeId);

  return NextResponse.json(prefill, { status: 200, headers: NO_STORE });
}
