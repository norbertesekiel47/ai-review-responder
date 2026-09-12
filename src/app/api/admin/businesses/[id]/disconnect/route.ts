import { NextRequest, NextResponse } from 'next/server';
import { internalError, requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { sql } from '@/lib/db/server';
import { zernioPublishingEnabled } from '@/lib/publishing/flags';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { disconnectZernioConnection } from '@/lib/zernio/disconnect';

export const dynamic = 'force-dynamic';

// Match the legacy endpoint's version-agnostic UUID validation.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  if (!zernioPublishingEnabled()) {
    return NextResponse.json(
      { error: 'feature_disabled' },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
  const { id: businessId } = await params;
  if (!UUID_REGEX.test(businessId)) {
    return NextResponse.json(
      { error: 'invalid_business_id' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const result = await disconnectZernioConnection(sql, businessId, 'admin');
    // Keep response statuses explicit for the generated Admin API contract.
    if (result.status === 403) {
      return NextResponse.json(result.body, { status: 403, headers: NO_STORE_HEADERS });
    }
    if (result.status === 404) {
      return NextResponse.json(result.body, { status: 404, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(result.body, { status: 200, headers: NO_STORE_HEADERS });
  } catch (error) {
    return internalError('admin/businesses/[id]/disconnect', error);
  }
}
