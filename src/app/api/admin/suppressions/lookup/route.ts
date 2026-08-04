// POST — look up every Suppression ledger row for one address (§7.3 servicing).
//
// This is a READ, and it is a POST anyway, deliberately. §9.5: never log the
// raw handle. A recipient address in a query string is logged by construction —
// it lands in Vercel access logs, in every log drain downstream of them, and in
// the admin's browser history — and no amount of care inside the handler can
// take it back out. The address therefore travels in the JSON body. Do NOT
// "simplify" this back to a GET on `/api/admin/suppressions?email=…`.
//
// A separate route segment from the entry surface for the same reason
// `correct/` is separate: both acts are POSTs to this prefix, so the segment is
// what distinguishes them, and neither ever shares a handler or a schema with
// the other.
//
// Route orchestrates only: AAL2 gate, body parse, one service call, mapped
// result. Deliberately NOT flag-gated (plan P-6): a statutory 10-business-day
// obligation behind a feature flag is a violation waiting for a flag flip.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { internalError, requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import {
  lookupSuppressions,
  type LookupSuppressionsResult,
} from '@/lib/admin/suppressions-service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const LookupSchema = z.strictObject({
  email: z.string().trim().min(1).max(320),
});

type LookupFailure = Extract<LookupSuppressionsResult, { ok: false }>;

/**
 * The wire contract for a failed lookup, spelled at the boundary instead of
 * inherited from the service union. Adding an `ok: false` variant to
 * `LookupSuppressionsResult` makes this record incomplete and fails typecheck —
 * which is the point. A new failure mode must choose its status here rather
 * than reach the client as a raw token inside a 200.
 */
const LOOKUP_ERROR_STATUS: Record<LookupFailure['error'], number> = {
  invalid_handle: 400,
};

async function lookup(request: NextRequest): Promise<NextResponse> {
  // Same sensitivity as /admin/flagged's read: the rows name recipients and the
  // accounts that mailed them across every tenant.
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
  const parsed = LookupSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const result = await lookupSuppressions(sql, parsed.data.email);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: LOOKUP_ERROR_STATUS[result.error], headers: NO_STORE_HEADERS },
      );
    }
    // Only the three fields the servicing surface renders. The service's
    // internal `ok` discriminant stays internal: serialising the union straight
    // out would make every future variant of it a silent wire-contract change.
    return NextResponse.json(
      { handle: result.handle, rows: result.rows, corrections: result.corrections },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    // §9.5: nothing identifying the recipient goes in the message — not the raw
    // input, not the Normalized handle. There is no row id to correlate on yet,
    // so this line carries the route and nothing else.
    return internalError('[api/admin/suppressions/lookup] failed:', error);
  }
}

// CSRF by construction: same-origin enforced at the export, not inside the gate.
export const POST = withSameOrigin()(lookup);
