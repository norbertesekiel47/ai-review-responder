// POST   — §7.5 owner do-not-contact on one contact (#645).
// DELETE — §7.6 clear a do-not-contact THIS account created. An owner may never
//          clear a global row: the repo predicate cannot reach one, so there is
//          no input to this route that expresses the forbidden operation.
// Route orchestrates only: flag gate + writable-owner auth (both inside
// requireContactsWriteAccess), location resolution, one repo call, mapped
// result. Mirrors the sibling DELETE /api/dashboard/contacts/[id].

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  clearContactDoNotContact,
  markContactDoNotContact,
} from '@/lib/solicitation/contacts-repo';
// Alias rather than `../../location-scope`: parent-traversal beyond one level
// is ESLint-restricted for src-internal imports.
import {
  requireContactsWriteAccess,
  resolveContactsScopedId,
} from '@/app/api/dashboard/contacts/location-scope';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const ENDPOINT = 'api/dashboard/contacts/[id]/suppression';
const NO_HANDLE_MESSAGE = 'This contact has no email address to suppress';

async function mark(request: NextRequest, { params }: Params): Promise<NextResponse> {
  // Mutation posture: flag gate + requireWritableOwner + same-origin, exactly
  // as the sibling contact delete.
  const owner = await requireContactsWriteAccess(sql, request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    const scoped = await resolveContactsScopedId(sql, request, {
      accountId,
      userLocationId: user.locationId,
    }, params);
    if (!scoped.ok) return scoped.response;

    const result = await markContactDoNotContact(sql, {
      accountId,
      businessId: scoped.locationId,
      contactId: scoped.id,
      actorUserId: user.id,
    });
    // A foreign contact and a missing one are the same 404 — the sibling delete
    // route's uniform-not-found posture (invariant #8).
    if (result === 'not_found') return errorResponse('Not found', 404);
    if (result === 'no_email_handle') return errorResponse(NO_HANDLE_MESSAGE, 409);
    return jsonResponse({ state: 'marked', alreadyMarked: result === 'already_marked' });
  } catch (error) {
    reportCaughtError(ENDPOINT, error, { accountId });
    return errorResponse('Failed to update contact', 500);
  }
}

async function clear(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const owner = await requireContactsWriteAccess(sql, request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    const scoped = await resolveContactsScopedId(sql, request, {
      accountId,
      userLocationId: user.locationId,
    }, params);
    if (!scoped.ok) return scoped.response;

    const result = await clearContactDoNotContact(sql, {
      accountId,
      businessId: scoped.locationId,
      contactId: scoped.id,
      actorUserId: user.id,
    });
    if (result === 'not_found') return errorResponse('Not found', 404);
    if (result === 'no_email_handle') return errorResponse(NO_HANDLE_MESSAGE, 409);
    // 'not_marked' covers "never marked" AND "suppressed globally, not by you":
    // both mean this account has no row to clear, and distinguishing them here
    // would tell the owner nothing they may act on — and would leak that
    // somebody else's ledger row exists.
    if (result === 'not_marked') return errorResponse('No do-not-contact to clear', 409);
    return jsonResponse({ state: 'cleared' });
  } catch (error) {
    reportCaughtError(ENDPOINT, error, { accountId });
    return errorResponse('Failed to update contact', 500);
  }
}

export const POST = withSameOrigin()(mark);
export const DELETE = withSameOrigin()(clear);
