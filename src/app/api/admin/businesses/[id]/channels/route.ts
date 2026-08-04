// src/app/api/admin/businesses/[id]/channels/route.ts
//
// Uses the existing auth helper at src/lib/db/auth.ts — `requireRole(request, ...roles)`
// throws AuthError on unauthenticated (401) or non-matching role (403).
// Mirrors the auth + dynamic-route pattern in src/app/api/admin/businesses/[id]/route.ts:74
// (Next.js 15: params is a Promise that must be awaited).
//
// The read itself lives in src/lib/admin/business-channels-service.ts so the
// admin business-detail server page can call it directly instead of round-tripping
// through this route (admin console Phase 3). This handler is a composition root:
// it imports the `sql` singleton and passes it down (invariant #15).
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRoleOr401 } from '@/lib/auth/route-helpers';
import { asLocationId } from '@/lib/shared/ids';
import type { LocationId } from '@/lib/shared/ids';
import { getBusinessChannelEnrollments } from '@/lib/admin/business-channels-service';

// Admin/customer data — never cache. Matches the pattern in the existing
// admin business detail API at src/app/api/admin/businesses/[id]/route.ts:7.
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: rawBusinessId } = await params;
  const businessId: LocationId = asLocationId(rawBusinessId);

  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  const data = await getBusinessChannelEnrollments(sql, businessId);
  return NextResponse.json(data);
}
