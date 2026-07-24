// GET /api/dashboard/contacts/uploads/[id] — upload status/report (#541).
// Route orchestrates only: flag gate, owner auth, location resolution; the
// tenant-scoped read lives in src/lib/solicitation/uploads.ts.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse } from '@/lib/auth/route-helpers';
import { isValidUuid } from '@/lib/shared/ids';
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
import { getUploadStatus } from '@/lib/solicitation/uploads';
import { withDashboardOwnerRead } from '@/app/api/dashboard/policy';
import { requireContactsLocationScope } from '@/app/api/dashboard/contacts/location-scope';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Flag gate FIRST (invariant #13): 404 before auth when watch-mode is off.
  if (!solicitationWatchEnabled()) return errorResponse('Not found', 404);

  return withDashboardOwnerRead(request, {
    errorContext: 'api/dashboard/contacts/uploads/[id]',
    errorMessage: 'Failed to fetch upload status',
  }, async ({ user, accountId }) => {
    const { id } = await params;
    // Uniform 404 for a malformed id: same exposure as an unknown upload.
    if (!isValidUuid(id)) return errorResponse('Not found', 404);

    const location = await requireContactsLocationScope(sql, request, {
      accountId,
      userLocationId: user.locationId,
    });
    if (!location.ok) return location.response;

    const status = await getUploadStatus(sql, accountId, location.locationId, id);
    if (!status) return errorResponse('Not found', 404);
    return jsonResponse(status);
  });
}
