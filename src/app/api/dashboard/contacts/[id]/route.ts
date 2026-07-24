// DELETE /api/dashboard/contacts/[id] — §5 hard delete of one contact (#541);
// its visits CASCADE via FK. Route orchestrates only: flag gate, writable-owner
// auth, location resolution; the tenant-scoped delete lives in
// src/lib/solicitation/contacts-repo.ts.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { deleteContact } from '@/lib/solicitation/contacts-repo';
import {
  requireContactsWriteAccess,
  resolveContactsScopedId,
} from '../location-scope';

export const dynamic = 'force-dynamic';

async function deleteContactHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Mutation posture: flag gate + requireWritableOwner + same-origin (mirrors
  // the uploads POST — the write-flavored sibling of the list route's read gate).
  const owner = await requireContactsWriteAccess(sql, request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    const scoped = await resolveContactsScopedId(sql, request, {
      accountId,
      userLocationId: user.locationId,
    }, params);
    if (!scoped.ok) return scoped.response;

    const deleted = await deleteContact(sql, accountId, scoped.locationId, scoped.id);
    if (!deleted) return errorResponse('Not found', 404);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    reportCaughtError('api/dashboard/contacts/[id]', error, { accountId });
    return errorResponse('Failed to delete contact', 500);
  }
}

export const DELETE = withSameOrigin()(deleteContactHandler);
