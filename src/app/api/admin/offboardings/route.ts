import { NextRequest, NextResponse } from 'next/server';
import { requireAdminWithAal2, internalError } from '@/lib/auth/admin-mfa-gate';
import { sql } from '@/lib/db/server';
import { getAdminOffboardings } from '@/lib/admin/offboardings-service';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  const limit = Math.min(
    Math.max(parseInt(request.nextUrl.searchParams.get('limit') ?? '50', 10) || 50, 1),
    100,
  );
  const offset = Math.max(
    parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0,
    0,
  );

  try {
    const { offboardings, total } = await getAdminOffboardings(sql, { limit, offset });

    return NextResponse.json({ offboardings, total, limit, offset }, { headers: NO_STORE });
  } catch (err) {
    return internalError('[api/admin/offboardings] list failed:', err);
  }
}
