// GET /api/dashboard/contacts — paginated contact list (#541).
// Route orchestrates only: flag gate, owner auth, location resolution, page
// parse; the tenant-scoped read lives in src/lib/solicitation/contacts-repo.ts.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse } from '@/lib/auth/route-helpers';
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
import { clampContactListPage, listContacts } from '@/lib/solicitation/contacts-repo';
import {
  resolveDashboardLocation,
  resolveDashboardRequest,
  withDashboardOwnerRead,
} from '@/app/api/dashboard/policy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Flag gate FIRST (invariant #13): 404 before auth when watch-mode is off.
  if (!solicitationWatchEnabled()) return errorResponse('Not found', 404);

  return withDashboardOwnerRead(request, {
    errorContext: 'api/dashboard/contacts',
    errorMessage: 'Failed to fetch contacts',
  }, async ({ user, accountId }) => {
    // Contacts are per-location, so the aggregate ("all locations") scope has
    // no meaning here — the location resolution mirrors the uploads routes.
    const { scopePolicy } = resolveDashboardRequest(request, user.locationId);
    if (scopePolicy.mode === 'aggregate') {
      return errorResponse('A location scope is required', 400);
    }

    const location = await resolveDashboardLocation(sql, {
      accountId,
      locationId: scopePolicy.locationId,
      exposure: 'uniform-not-found',
    });
    if (!location.ok) return location.response;

    // Untrusted query params → clamped bounds (single owner of the rule:
    // clampContactListPage) before any SQL sees them.
    const page = clampContactListPage({
      limit: Number.parseInt(request.nextUrl.searchParams.get('limit') ?? '', 10),
      offset: Number.parseInt(request.nextUrl.searchParams.get('offset') ?? '', 10),
    });

    const result = await listContacts(sql, accountId, location.locationId, page);
    return jsonResponse(result);
  });
}
