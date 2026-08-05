// PUT /api/settings/postal-address (#656)
//
// The owner's Attested postal address for the location they are CURRENTLY
// looking at. The handler parses, delegates to exactly one module function
// (`attestPostalAddress`), and maps its four statuses to HTTP — the lint, the
// normalization, the digest and the actor-membership predicate all live in
// `src/lib/solicitation/postal-address.ts` (working rule: entry points
// orchestrate).
//
// Auth is `resolveOwnerScope`, deliberately NOT `requireSettingsOwner`. That
// helper resolves no location and, per its own doc comment, skips the
// writable-subscription gate ("settings reads and rival/auto-approval writes
// stay available to past-due accounts"). This route needs the opposite of both:
// a cookie-resolved active location to write, and a refusal for a non-writable
// subscription. `resolveOwnerScope` returns { accountId, locationId, userId } —
// `locationId` resolved from the `rw_location_scope` cookie via getRequestScope
// (falling back to primary), and `userId` = `users.id`, which is the PK the
// attestation column stores, NOT the Supabase Auth UID.
//
// Two things `resolveOwnerScope` does not do, and how they are covered here:
//
//  - CSRF. Its doc comment says callers must handle it, so the handler is
//    wrapped in `withSameOrigin()`.
//  - Offboarding. The subscription gate does NOT imply it: `isFullBlockState`
//    is true for mode `delete_data` at ANY status, while confirming offboarding
//    does not itself cancel the subscription (Stripe is the source of truth and
//    cancellation is a separate async step). A `delete_data`/`pending` account
//    is therefore still `active`, sails through `resolveOwnerScope`, and would
//    be able to edit its sender address mid-teardown. The block is re-applied
//    explicitly below, BEFORE the body is even read — same shape as
//    `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts:103-106`.
//
// Dropping `requireSettingsOwner` also drops its `?accountId` rejection. Safe
// here: this route reads no query parameters at all, so the parameter is inert
// rather than half-honoured.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOffboardingState, isOperationalUIBlocked } from '@/lib/account-offboarding/gate';
import { resolveOwnerScope, ScopeError } from '@/lib/auth/resolve-owner-scope';
import { jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import {
  POSTAL_ADDRESS_ATTESTATION_VERSION,
  attestPostalAddress,
  type AttestPostalAddressResult,
} from '@/lib/solicitation/postal-address';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

// `strictObject` is load-bearing: a client-supplied `businessId` or `userId`
// must be a 400, never a silently ignored field. Both facts are server-derived
// from the session — the location from the `rw_location_scope` cookie, the
// attester from `users.id` — so a body that could name either is a
// tenant-selection knob.
//
// `attested` is `literal(true)`: an unchecked box is a 400, never a silent
// skip. `attestationVersion` is pinned to the constant so an unknown or stale
// version is refused BEFORE any write — a client must never assent to one text
// while the server records another.
//
// `address` is bounded but NOT linted here: the lint lives in
// `attestPostalAddress`, which takes the raw value, so there is exactly one
// author of what a valid address is and no path that stores an unlinted one.
const UpdatePostalAddressSchema = z.strictObject({
  address: z.string().min(1).max(500),
  attestationVersion: z.literal(POSTAL_ADDRESS_ATTESTATION_VERSION),
  attested: z.literal(true),
});

async function putPostalAddress(request: NextRequest): Promise<NextResponse> {
  let scope;
  try {
    scope = await resolveOwnerScope(sql, request);
  } catch (error) {
    if (error instanceof ScopeError) {
      return jsonResponse({ error: error.message }, error.statusCode);
    }
    throw error;
  }

  // Before the body parse and before any write — see the header note.
  const offboardingState = await getOffboardingState(scope.accountId, sql);
  if (isOperationalUIBlocked(offboardingState)) {
    return jsonResponse({ error: 'account_offboarding_blocked' }, 403);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  const parsed = UpdatePostalAddressSchema.safeParse(rawBody);
  if (!parsed.success) return jsonResponse({ error: 'invalid_request' }, 400);

  try {
    const result = await attestPostalAddress(sql, {
      accountId: scope.accountId,
      // Cookie-resolved active location, never the account's primary location:
      // in a multi-location account the two differ, and writing the primary
      // would attest an address the owner never looked at.
      businessId: scope.locationId,
      // `users.id`, never the Supabase Auth UID and never a body-supplied value.
      userId: scope.userId,
      address: parsed.data.address,
    });
    return attestationResponse(result);
  } catch (error) {
    reportCaughtError('api/settings/postal-address PUT', error, {
      accountId: scope.accountId,
      businessId: scope.locationId,
    });
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}

/**
 * The module's four statuses, one HTTP mapping each. `invalid` carries the lint
 * reason so the settings panel can render it inline without re-deriving the
 * rule. Never logs the address itself.
 */
function attestationResponse(result: AttestPostalAddressResult): NextResponse {
  switch (result.status) {
    case 'attested':
      return jsonResponse({ status: 'attested' });
    case 'invalid':
      return jsonResponse({ error: 'invalid_address', reason: result.reason }, 400);
    case 'actor_not_in_account':
      return jsonResponse({ error: 'actor_not_in_account' }, 403);
    case 'business_not_found':
      return jsonResponse({ error: 'business_not_found' }, 404);
  }
}

export const PUT = withSameOrigin()(putPostalAddress);
