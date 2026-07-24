// DELETE /api/dashboard/contacts/[id] — §5 hard delete of one contact (#541);
// its visits CASCADE via FK. Route orchestrates only: flag gate, writable-owner
// auth, location resolution; the tenant-scoped delete lives in
// src/lib/solicitation/contacts-repo.ts.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import {
  errorResponse,
  requireWritableOwner,
  withSameOrigin,
} from '@/lib/auth/route-helpers';
import { isValidUuid } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
import { deleteContact } from '@/lib/solicitation/contacts-repo';
import { requireContactsLocationScope } from '../location-scope';

export const dynamic = 'force-dynamic';

async function deleteContactHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Flag gate FIRST (invariant #13): 404 before auth when watch-mode is off.
  if (!solicitationWatchEnabled()) return errorResponse('Not found', 404);

  // Mutation posture: requireWritableOwner + same-origin (mirrors the uploads
  // POST — the write-flavored sibling of the list route's read gate).
  const owner = await requireWritableOwner(sql, request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    const { id } = await params;
    // Uniform 404 for a malformed id: same exposure as an unknown contact.
    if (!isValidUuid(id)) return errorResponse('Not found', 404);

    const location = await requireContactsLocationScope(sql, request, {
      accountId,
      userLocationId: user.locationId,
    });
    if (!location.ok) return location.response;

    const deleted = await deleteContact(sql, accountId, location.locationId, id);
    if (!deleted) return errorResponse('Not found', 404);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    reportCaughtError('api/dashboard/contacts/[id]', error, { accountId });
    return errorResponse('Failed to delete contact', 500);
  }
}

export const DELETE = withSameOrigin()(deleteContactHandler);
