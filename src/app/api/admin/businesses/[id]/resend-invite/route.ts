import { NextRequest, NextResponse } from 'next/server';
import { sql, supabaseServer } from '@/lib/db/server';
import { asLocationId } from '@/lib/shared/ids';
import type { LocationId } from '@/lib/shared/ids';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  ResendInviteError,
  resendOwnerInvite,
} from '@/lib/onboarding/resend-invite';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// POST /api/admin/businesses/[id]/resend-invite — re-send the owner invite
//
// Guard stack copied from createBusiness (src/app/api/admin/businesses/route.ts):
// requireAdminWithAal2 first, same-origin at the export. Orchestration only
// (invariant #12) — every eligibility rule, provider call and failure decision
// lives in src/lib/onboarding/resend-invite.ts.
// ---------------------------------------------------------------------------

/**
 * Per-Business cap on outbound invite emails, fail-CLOSED (`strict: true`, so a
 * Redis outage 503s rather than silently uncapping — the demo route's posture).
 *
 * Why a limit at all on an admin+AAL2 route: this is the one admin action that
 * puts mail in a *customer's* inbox on demand. A stuck client retry or a
 * double-click storm is a deliverability incident (spam complaints against our
 * sending domain), and Supabase's own `over_email_send_rate_limit` is
 * project-global — burning it here would break real signups, not just this
 * button. Three per hour is well above any honest use (the admin resends once,
 * maybe twice after a bounce) and well below "inbox flood".
 *
 * The counter is spent BEFORE eligibility is evaluated, so a rejected attempt
 * (409 already-signed-in, 404, …) consumes budget too. That is deliberate —
 * moving the check past the module call would put it after the send — hence
 * the 429 copy talks about *attempts*, not deliveries.
 */
const RESEND_INVITE_MAX_PER_HOUR = 3;
const RESEND_INVITE_WINDOW_SECONDS = 3600;

async function enforceResendRateLimit(
  businessId: LocationId,
): Promise<NextResponse | null> {
  try {
    const limit = await checkRateLimit(
      `admin:resend-invite:business:${businessId}`,
      RESEND_INVITE_MAX_PER_HOUR,
      RESEND_INVITE_WINDOW_SECONDS,
      { strict: true },
    );
    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: `${RESEND_INVITE_MAX_PER_HOUR} resend attempts already made for this business in the last hour. Wait before trying again.`,
        },
        { status: 429 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'Rate limiting unavailable — try again later' },
      { status: 503 },
    );
  }
  return null;
}

async function resendInvite(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: rawBusinessId } = await params;

  // Auth before spend: no rate-limit budget and no provider round-trip for a
  // caller that has not cleared MFA step-up.
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  const businessId: LocationId = asLocationId(rawBusinessId);

  const limited = await enforceResendRateLimit(businessId);
  if (limited) return limited;

  try {
    const result = await resendOwnerInvite(sql, supabaseServer, businessId);
    return NextResponse.json({
      success: true,
      resentAt: result.resentAt,
      ownerEmailRedacted: result.ownerEmailRedacted,
    });
  } catch (err) {
    if (err instanceof ResendInviteError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    reportCaughtError('api/admin/businesses/[id]/resend-invite POST', err, {
      businessId,
    });
    return NextResponse.json(
      { error: 'Failed to resend the owner invite' },
      { status: 500 },
    );
  }
}

export const POST = withSameOrigin()(resendInvite);
