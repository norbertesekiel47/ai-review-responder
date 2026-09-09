// src/app/api/admin/businesses/[id]/channels/route.ts
//
// Gated by the admin control-plane gate `requireAdminWithAal2` (@/lib/auth/admin-mfa-gate),
// which owns the whole refusal contract: 401 Unauthorized / 403 Forbidden /
// 403 mfa_required / 500 internal_error, all no-store.
// Mirrors the auth + dynamic-route pattern in src/app/api/admin/businesses/[id]/route.ts
// (Next.js 15: params is a Promise that must be awaited).
//
// The read itself lives in src/lib/admin/business-channels-service.ts so the
// admin business-detail server page can call it directly instead of round-tripping
// through this route (admin console Phase 3). This handler is a composition root:
// it imports the `sql` singleton and passes it down (invariant #15).
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { asLocationId } from '@/lib/shared/ids';
import type { LocationId } from '@/lib/shared/ids';
import { getBusinessChannelEnrollments } from '@/lib/admin/business-channels-service';

// Admin/customer data — never cache. Matches the pattern in the existing
// admin business detail API at src/app/api/admin/businesses/[id]/route.ts:7.
export const dynamic = 'force-dynamic';

// Convention: the gate is the FIRST statement, so the handler does no work at all —
// not even reading `params` — before the caller is authorized.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  const { id: rawBusinessId } = await params;
  const businessId: LocationId = asLocationId(rawBusinessId);

  const data = await getBusinessChannelEnrollments(sql, businessId);
  return NextResponse.json(data);
}
