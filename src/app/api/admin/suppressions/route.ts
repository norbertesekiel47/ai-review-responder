// POST — admin manual entry (§7.3).
// The lookup that precedes it lives at `lookup/route.ts`, not on a GET here:
// §9.5 forbids logging the raw handle, and a query string is logged by
// construction. See that file's header for the full reasoning.
// Route orchestrates only: AAL2 gate, body parse, one service call, mapped
// result. Deliberately NOT flag-gated (plan P-6): a statutory 10-business-day
// obligation behind a feature flag is a violation waiting for a flag flip.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { internalError, requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { recordAdminManualSuppression } from '@/lib/admin/suppressions-service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { parseJsonBody } from './_guard';

export const dynamic = 'force-dynamic';

const EntrySchema = z.strictObject({
  email: z.string().trim().min(1).max(320),
  // Required, per §7.3: the originating message reference is what makes the
  // entry auditable ten business days later.
  note: z.string().trim().min(1).max(1_000),
});

async function recordEntry(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  const body = await parseJsonBody(request, EntrySchema);
  if (!body.ok) return body.response;

  try {
    // The actor comes from the AAL2 gate, never from the body — EntrySchema is
    // a strictObject precisely so a client-supplied actor field is a 400 rather
    // than a silently ignored key.
    const result = await sql.begin((tx) => recordAdminManualSuppression(tx, {
      rawEmail: body.data.email,
      adminUserId: gate.admin.id,
      note: body.data.note,
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
