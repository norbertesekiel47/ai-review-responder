import { NextRequest, NextResponse } from 'next/server';
import { OnboardBusinessSchema } from '@/lib/shared/schemas';
import { sql, supabaseServer } from '@/lib/db/server';
import {
  onboardBusinessAsAdmin,
  AdminOnboardingError,
} from '@/lib/onboarding/admin-onboarding-service';
import { requireRoleOr401, withSameOrigin } from '@/lib/auth/route-helpers';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { getAdminBusinessesList } from '@/lib/admin/businesses-list-service';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/admin/businesses — paginated business list
//
// The queries + row mapping live in src/lib/admin/businesses-list-service.ts so
// the /admin/businesses server page can read the same data without going
// through HTTP. This handler keeps the query-param parsing/clamping and echoes
// `limit`/`offset` back — the response shape is unchanged.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const limit = Math.min(
      Math.max(parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10) || 20, 1),
      100,
    );
    const offset = Math.max(
      parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0,
      0,
    );

    const data = await getAdminBusinessesList(sql, { limit, offset });

    return NextResponse.json({ ...data, limit, offset });
  } catch (error) {
    reportCaughtError('api/admin/businesses GET', error);
    return NextResponse.json(
      { error: 'Failed to fetch businesses' },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/admin/businesses — onboard a new business
// ---------------------------------------------------------------------------

async function createBusiness(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;
  const admin = gate.admin;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = OnboardBusinessSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  try {
    const result = await onboardBusinessAsAdmin(sql, supabaseServer, {
      ...parsed.data,
      onboardedBy: admin.id,
    });
    return NextResponse.json(
      { id: result.businessId, paymentUrl: result.paymentUrl },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof AdminOnboardingError) {
      const body: { error: string; rollback?: typeof err.rollback } = {
        error: err.message,
      };
      // Surface orphan IDs from a partially-failed rollback (currently only
      // emitted by LINK_AUTH_ID_FAILED). Lets the admin UI display exactly
      // which records need manual cleanup instead of a generic 500.
      if (err.rollback) {
        body.rollback = err.rollback;
      }
      return NextResponse.json(body, { status: err.status });
    }
    reportCaughtError('api/admin/businesses POST', err);
    return NextResponse.json(
      { error: 'Failed to onboard business' },
      { status: 500 },
    );
  }
}

export const POST = withSameOrigin()(createBusiness);
