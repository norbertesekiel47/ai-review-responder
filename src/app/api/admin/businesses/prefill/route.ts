import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { isPlaceId } from '@/lib/reviews/url-parser';
import { fetchBusinessDetails } from '@/lib/reviews/serpapi-prefill';

// ── Documented invariant exception ───────────────────────────────────
// CLAUDE.md invariant: "Vercel serves UI only. All SLA-critical compute
// runs on Railway." This route makes an outbound SerpAPI call from a
// Vercel serverless function, which is an EXCEPTION to that rule. It is
// justified because:
//   1. The call is admin-only and user-triggered (a human selects a
//      place in the PlaceAutocomplete UI; not triggered automatically).
//   2. The admin is sitting in front of the form and needs sub-second
//      feedback — shipping this to Railway would add round-trip latency
//      to the only code path that demands it.
//   3. A 2s Promise.race timeout bounds worst-case latency (see
//      `SERPAPI_TIMEOUT_MS` in `serpapi-prefill.ts`).
//   4. A 10/min per-admin strict rate limit (fail-closed when Redis is
//      unavailable — see `checkRateLimit` below) prevents uncapped
//      SerpAPI spend even under malicious or buggy client loops.
//   5. Cost is recorded to `api_costs` (business_id=NULL) on every
//      outbound call, including timeouts and API errors, so spend is
//      visible in `/admin/costs` and subject to the same audit trail
//      as Railway-originated calls.
// If volume ever becomes a concern, the call can be moved behind a
// Railway endpoint without changing the API contract.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Auth
  let user: { id: string };
  try {
    user = await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode, headers: NO_STORE },
      );
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // 2. Validate query param
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

  // 3. Rate limit — strict mode so Redis unavailability returns 503 instead of
  //    silently allowing uncapped SerpAPI calls.
  try {
    const { allowed } = await checkRateLimit(
      `prefill:minute:${user.id}`,
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

  // 4. Fetch prefill — never throws; worst case returns all-null
  const prefill = await fetchBusinessDetails(placeId);

  return NextResponse.json(prefill, { status: 200, headers: NO_STORE });
}
