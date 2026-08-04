// POST   — §7.5 owner do-not-contact on one contact (#645).
// DELETE — §7.6 clear a do-not-contact THIS account created. An owner may never
//          clear a global row: the repo predicate cannot reach one, so there is
//          no input to this route that expresses the forbidden operation.
// Route orchestrates only: the flag gate, writable-owner auth, location
// resolution and the 500 mapping are the shared `[id]` policy owned by
// withScopedContact (location-scope.ts) — the same preamble the sibling
// DELETE /api/dashboard/contacts/[id] runs. What is left here is one repo call
// per direction and the result mapping, which is all that legitimately differs.

import { NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import {
  clearContactDoNotContact,
  markContactDoNotContact,
  type ClearDoNotContactResult,
  type MarkDoNotContactResult,
} from '@/lib/solicitation/contacts-repo';
// Alias rather than `../../location-scope`: parent-traversal beyond one level
// is ESLint-restricted for src-internal imports.
import {
  withScopedContact,
  type ScopedContactContext,
} from '@/app/api/dashboard/contacts/location-scope';

export const dynamic = 'force-dynamic';

const ENDPOINT = 'api/dashboard/contacts/[id]/suppression';
const FAILURE_MESSAGE = 'Failed to update contact';
const NO_HANDLE_MESSAGE = 'This contact has no email address to suppress';

/** The four scope fields both repo calls take, in one place. */
function repoArgs(scoped: ScopedContactContext) {
  return {
    accountId: scoped.accountId,
    businessId: scoped.locationId,
    contactId: scoped.contactId,
    actorUserId: scoped.actorUserId,
  };
}

/**
 * The two outcomes both directions share, mapped identically on purpose.
 * Returns null when the result is direction-specific — the caller owns that
 * mapping, because §7.6 requires mark and clear to speak with distinct copy.
 */
function sharedFailure(
  result: MarkDoNotContactResult | ClearDoNotContactResult,
): NextResponse | null {
  // A foreign contact and a missing one are the same 404 — the sibling delete
  // route's uniform-not-found posture (invariant #8).
  if (result === 'not_found') return errorResponse('Not found', 404);
  if (result === 'no_email_handle') return errorResponse(NO_HANDLE_MESSAGE, 409);
  return null;
}

async function mark(scoped: ScopedContactContext): Promise<NextResponse> {
  const result = await markContactDoNotContact(sql, repoArgs(scoped));
  return (
    sharedFailure(result) ??
    jsonResponse({ state: 'marked', alreadyMarked: result === 'already_marked' })
  );
}

async function clear(scoped: ScopedContactContext): Promise<NextResponse> {
  const result = await clearContactDoNotContact(sql, repoArgs(scoped));
  const shared = sharedFailure(result);
  if (shared) return shared;
  // 'not_marked' covers "never marked" AND "suppressed globally, not by you":
  // both mean this account has no row to clear, and distinguishing them here
  // would tell the owner nothing they may act on — and would leak that
  // somebody else's ledger row exists.
  if (result === 'not_marked') return errorResponse('No do-not-contact to clear', 409);
  return jsonResponse({ state: 'cleared' });
}

const policy = { endpoint: ENDPOINT, failureMessage: FAILURE_MESSAGE };

export const POST = withSameOrigin()(withScopedContact(sql, policy, mark));
export const DELETE = withSameOrigin()(withScopedContact(sql, policy, clear));
