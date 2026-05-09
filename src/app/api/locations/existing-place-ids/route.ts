// src/app/api/locations/existing-place-ids/route.ts
//
// GET /api/locations/existing-place-ids — Returns the set of Google Place IDs
// already used by active locations in the current account.
// Used by the add-location wizard for client-side duplicate validation
// (VAL-SETTINGS-044).

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Gate by MULTI_LOCATION_ENABLED
  if (process.env.MULTI_LOCATION_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  if (!user.accountId) {
    return NextResponse.json(
      { error: 'No account associated with this user' },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  // Fetch all active (non-archived) Place IDs for this account
  const rows = await sql<{ google_place_id: string }[]>`
    SELECT google_place_id
    FROM businesses
    WHERE account_id = ${user.accountId}::uuid
      AND archived_at IS NULL
      AND google_place_id IS NOT NULL
  `;

  const placeIds = rows.map((r) => r.google_place_id);

  return NextResponse.json(
    { placeIds },
    { headers: NO_STORE_HEADERS },
  );
}
