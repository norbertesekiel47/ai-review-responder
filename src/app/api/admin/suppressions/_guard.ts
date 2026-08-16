// The JSON-body parse + schema step shared by the three admin suppressions
// routes (entry, lookup, correct).
//
// Extracted because all three opened with the same ~14 lines of `request.json()`
// inside a try plus a `safeParse` and two near-identical 400s. That is the same
// duplication the owner side already collapsed into `withScopedContact` during
// review, and it reads identically here.
//
// WHY THIS DOES NOT ALSO WRAP THE AAL2 GATE. An earlier version of this file
// did, and it was wrong: `scripts/ci/admin-aal2-audit.ts` asserts that every
// exported mutation handler on an admin route REACHES `requireAdminWithAal2`.
// Hiding the call behind a wrapper made three real, still-gated routes read as
// ungated and turned the audit red — and the audit is right to be strict,
// because "is this admin mutation MFA-gated?" should be answerable by reading
// the route, not by following a wrapper. Since the audit became an AST scan it
// follows local delegation within a route file (`withSameOrigin()(inner)`), but
// an imported wrapper still terminates the walk and is a finding by design —
// fail-closed. The gate therefore stays spelled out in each route; only the
// body handling lives here.

import type { NextRequest, NextResponse } from 'next/server';
import { NextResponse as Response } from 'next/server';
import type { z } from 'zod';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

/**
 * The first zod issue's message — the default for a body whose fields are not
 * themselves sensitive, so a caller learns which field it got wrong.
 */
function zodIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'invalid_request';
}

/**
 * A flat `invalid_body`, discarding what zod actually objected to. For a body
 * whose *field* is the recipient address: §9.5 keeps the handle out of logs and
 * responses, and the narrower error is not worth widening that surface for.
 */
export function opaqueBodyError(): string {
  return 'invalid_body';
}

export type ParsedBody<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

/**
 * Reads and validates a JSON request body.
 *
 * `schemaError` decides what a schema rejection tells the caller — pass
 * `opaqueBodyError` when the body carries a Normalized handle. A malformed JSON
 * envelope is always a flat `invalid_body`: there is no validated field to name.
 */
export async function parseJsonBody<T>(
  request: NextRequest,
  schema: z.ZodType<T>,
  schemaError: (error: z.ZodError) => string = zodIssueMessage,
): Promise<ParsedBody<T>> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return { ok: false, response: badRequest('invalid_body') };
  }

  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return { ok: false, response: badRequest(schemaError(parsed.error)) };
  }

  return { ok: true, data: parsed.data };
}

function badRequest(error: string): NextResponse {
  return Response.json({ error }, { status: 400, headers: NO_STORE_HEADERS });
}
