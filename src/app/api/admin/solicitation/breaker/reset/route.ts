import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { internalError, requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { resetSendBreaker } from '@/lib/solicitation/send-breaker';

export const dynamic = 'force-dynamic';

// strictObject is load-bearing: a body carrying actorUserId is REJECTED, not
// silently overridden, so a caller cannot believe it chose the actor. The
// actor comes from gate.admin.id — the same discipline adminHaltBatch applies
// to its reason (identity fixes it; no request field can name it).
//
// The note is required here as well as by 110's reset_consistency CHECK: a
// blank one must surface as a 400 the operator can act on, not as a 23514
// mapped to 500.
const ResetSchema = z.strictObject({
  note: z.string().trim().min(1).max(1_000),
});

async function reset(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_body' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const parsed = ResetSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const result = await sql.begin((tx) => resetSendBreaker(tx, {
      actorUserId: gate.admin.id,
      note: parsed.data.note,
    }));
    if (!result.reset) {
      // Nothing was open — mirrors the unsuspend route's not_suspended arm.
      return NextResponse.json(
        { error: 'not_tripped' },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { reset: true, tripId: result.tripId },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return internalError('[api/admin/solicitation/breaker/reset] failed:', error);
  }
}

export const POST = withSameOrigin()(reset);
