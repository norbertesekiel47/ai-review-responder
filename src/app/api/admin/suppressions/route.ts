// GET  — look up every Suppression ledger row for one address (§7.3 servicing).
// POST — admin manual entry (§7.3).
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
  recordAdminManualSuppression,
} from '@/lib/admin/suppressions-service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Same sensitivity as /admin/flagged's GET: the rows name recipients and the
  // accounts that mailed them across every tenant. No same-origin wrapper — a
  // GET is not a mutation.
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  const email = request.nextUrl.searchParams.get('email') ?? '';
  const result = await lookupSuppressions(sql, email);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  return NextResponse.json(result, { headers: NO_STORE_HEADERS });
}

const EntrySchema = z.strictObject({
  email: z.string().trim().min(1).max(320),
  // Required, per §7.3: the originating message reference is what makes the
  // entry auditable ten business days later.
  note: z.string().trim().min(1).max(1_000),
});

async function recordEntry(request: NextRequest): Promise<NextResponse> {
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
  const parsed = EntrySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    // The actor comes from the AAL2 gate, never from the body — EntrySchema is
    // a strictObject precisely so a client-supplied actor field is a 400 rather
    // than a silently ignored key.
    const result = await sql.begin((tx) => recordAdminManualSuppression(tx, {
      rawEmail: parsed.data.email,
      adminUserId: gate.admin.id,
      note: parsed.data.note,
    }));
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { created: result.created, handle: result.handle },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return internalError('[api/admin/suppressions] entry failed:', error);
  }
}

// CSRF by construction: same-origin enforced at the export, not inside the gate.
export const POST = withSameOrigin()(recordEntry);
