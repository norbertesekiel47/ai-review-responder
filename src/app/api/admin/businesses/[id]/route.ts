import { NextRequest, NextResponse } from 'next/server';
import { UpdateBusinessSchema } from '@/lib/shared/schemas';
import { asLocationId } from '@/lib/shared/ids';
import type { LocationId } from '@/lib/shared/ids';
import {
  AdminBusinessNotFoundError,
  FIELD_TO_COLUMN,
  getBusinessDetail,
  updateBusiness,
} from '@/lib/admin/business-detail-service';
import { requireRoleOr401, withSameOrigin } from '@/lib/auth/route-helpers';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/admin/businesses/[id] — business detail + reviews + latest responses
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: rawBusinessId } = await params;
  const businessId: LocationId = asLocationId(rawBusinessId);

  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const detail = await getBusinessDetail(businessId);
    if (!detail) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    reportCaughtError('api/admin/businesses/[id] GET', error, { businessId });
    return NextResponse.json({ error: 'Failed to fetch business' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/businesses/[id] — update business settings
// ---------------------------------------------------------------------------

async function patchBusiness(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: rawBusinessId } = await params;
  const businessId: LocationId = asLocationId(rawBusinessId);

  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = UpdateBusinessSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const fields = Object.keys(data) as (keyof typeof data)[];

  // Defense-in-depth: every field must map to a hardcoded column whitelist
  // entry that also matches the COLUMN_RE pattern. Reject before any SQL is
  // built so a future refactor that accidentally accepts dynamic column
  // names hard-fails here instead of reaching `tx.unsafe`.
  const COLUMN_RE = /^[a-z][a-z0-9_]*$/;
  for (const field of fields) {
    const column = FIELD_TO_COLUMN[field];
    if (!column || !COLUMN_RE.test(column)) {
      return NextResponse.json(
        { error: `Invalid field: ${field}` },
        { status: 400 },
      );
    }
  }

  try {
    await updateBusiness(businessId, data);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AdminBusinessNotFoundError) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }
    // Duplicate email constraint (users.email or channel_enrollments UNIQUE) —
    // match the POST route's 409 semantics at src/app/api/admin/businesses/route.ts:281-287.
    // MUST come before the generic 500 fallback.
    const pgError = error as { code?: string };
    if (pgError.code === '23505') {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 });
    }
    reportCaughtError('api/admin/businesses/[id] PATCH', error, { businessId });
    return NextResponse.json({ error: 'Failed to update business' }, { status: 500 });
  }
}

export const PATCH = withSameOrigin()(patchBusiness);
