import { NextRequest, NextResponse } from 'next/server';
import { OnboardBusinessSchema } from '@/lib/shared/schemas';
import { sql } from '@/lib/db/server';
import {
  onboardBusinessAsAdmin,
  AdminOnboardingError,
} from '@/lib/onboarding/admin-onboarding-service';
import { requireRoleOr401, withSameOrigin } from '@/lib/auth/route-helpers';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/admin/businesses — paginated business list
// ---------------------------------------------------------------------------

interface BusinessListRow {
  id: string;
  name: string;
  category: string | null;
  subscription_status: string;
  last_sync_at: Date | null;
  pending_count: number;
}

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

    const [businessRows, countRows] = await Promise.all([
      sql<BusinessListRow[]>`
        SELECT
          b.id,
          b.name,
          b.category,
          a.subscription_status,
          b.last_sync_at,
          COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_count
        FROM businesses b
        JOIN accounts a ON a.id = b.account_id
        LEFT JOIN responses resp
          ON resp.business_id = b.id AND resp.status != 'superseded'
        GROUP BY b.id, b.name, b.category, a.subscription_status, b.last_sync_at
        ORDER BY b.name ASC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM businesses`,
    ]);

    return NextResponse.json({
      businesses: businessRows.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category ?? null,
        subscriptionStatus: row.subscription_status,
        lastSyncAt: row.last_sync_at ? row.last_sync_at.toISOString() : null,
        pendingCount: row.pending_count,
      })),
      total: countRows[0]?.total ?? 0,
      limit,
      offset,
    });
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
    const result = await onboardBusinessAsAdmin({
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
