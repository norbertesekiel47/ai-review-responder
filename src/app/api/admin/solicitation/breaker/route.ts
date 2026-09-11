import { NextRequest, NextResponse } from 'next/server';
import { internalError, requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { sql } from '@/lib/db/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import {
  BREAKER_COMPLAINT_RATE,
  BREAKER_HARD_BOUNCE_RATE,
  BREAKER_MIN_SENDS,
  BREAKER_WINDOW_DAYS,
  readSendBreaker,
} from '@/lib/solicitation/send-breaker';

export const dynamic = 'force-dynamic';

/**
 * The Send breaker's current state, for the /admin/solicitation panel.
 *
 * Read-only, but gated with `requireAdminWithAal2` to match the reset route it
 * sits beside — the panel and the control it hosts have one audience.
 *
 * `trippedAt` is serialised to an ISO string here and by the page's
 * server-rendered `initialData`, so a refetch is structurally identical to the
 * first render.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  try {
    const state = await readSendBreaker(sql);
    return NextResponse.json(
      {
        open: state.open,
        trip: state.trip && { ...state.trip, trippedAt: state.trip.trippedAt.toISOString() },
        // The separate Admin app displays the enforcement values through this
        // seam, so they must come from the same constants as the breaker.
        thresholds: {
          windowDays: BREAKER_WINDOW_DAYS,
          minSends: BREAKER_MIN_SENDS,
          hardBounceRate: BREAKER_HARD_BOUNCE_RATE,
          complaintRate: BREAKER_COMPLAINT_RATE,
        },
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    // readSendBreaker throws rather than reporting an unknown verdict — that
    // throw is the SEND path's halt signal. On this read surface it is just a
    // failed panel load, so it maps to the standard 500.
    return internalError('[api/admin/solicitation/breaker] failed:', error);
  }
}
