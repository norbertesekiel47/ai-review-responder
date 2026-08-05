// DELETE /api/dashboard/contacts/[id] — §5 hard delete of one contact (#541);
// its visits CASCADE via FK. Route orchestrates only: the flag gate, owner
// auth, location resolution and the 500 mapping all live in withScopedContact
// (location-scope.ts, the single owner of that policy); the tenant-scoped
// delete lives in src/lib/solicitation/contacts-repo.ts.

import { NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { deleteContact } from '@/lib/solicitation/contacts-repo';
import { withScopedContact } from '../location-scope';

export const dynamic = 'force-dynamic';

// Mutation posture: flag gate + requireWritableOwner (inside withScopedContact)
// + same-origin (mirrors the uploads POST — the write-flavored sibling of the
// list route's read gate).
export const DELETE = withSameOrigin()(
  withScopedContact(
    sql,
    { endpoint: 'api/dashboard/contacts/[id]', failureMessage: 'Failed to delete contact' },
    async ({ accountId, locationId, contactId }) => {
      const deleted = await deleteContact(sql, accountId, locationId, contactId);
      // A foreign contact and a missing one are the same 404 (invariant #8).
      if (!deleted) return errorResponse('Not found', 404);
      return new NextResponse(null, { status: 204 });
    },
  ),
);
