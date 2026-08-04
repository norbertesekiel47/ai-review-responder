// POST — the Correction path (§8.2): admin-only, audited removal of a
// factually-wrong suppression row. Error correction, NEVER re-subscribe.
// A separate route from the entry surface so the two acts never share a
// handler, a schema, or a copy string.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { internalError, requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { correctSuppression } from '@/lib/admin/suppressions-service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const CorrectSchema = z.strictObject({
  suppressionId: z.uuid(),
  // "Why" is not optional on this path — it is the audit record's whole point.
  reason: z.string().trim().min(1).max(1_000),
});

async function correct(request: NextRequest): Promise<NextResponse> {
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
  const parsed = CorrectSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    // No sql.begin: correctSuppression is a single statement (P-9), so the
    // transaction would add a moving part without adding a guarantee. The
    // actor id comes from the AAL2 gate, never from the body — CorrectSchema is
    // a strictObject precisely so a client-supplied actor field is a 400 rather
    // than a silently ignored key.
    const result = await correctSuppression(sql, {
      suppressionId: parsed.data.suppressionId,
      adminUserId: gate.admin.id,
      reason: parsed.data.reason,
    });
    if (result === 'not_found') {
      return NextResponse.json(
        { error: 'not_found' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json({ corrected: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    // §9.5: the suppression row id is the correlation key, never the Normalized
    // handle. The neighbouring admin routes log nothing on success, so this
    // route does not introduce a success log line either.
    return internalError(
      `[api/admin/suppressions/correct] failed for ${parsed.data.suppressionId}:`,
      error,
    );
  }
}

// CSRF by construction: same-origin enforced at the export, not inside the gate.
export const POST = withSameOrigin()(correct);
