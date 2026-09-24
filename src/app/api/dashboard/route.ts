import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { jsonResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { readGatedDashboard } from '@/lib/dashboard/subscription-gate';
import { resolveDashboardRequest } from './policy';

export const dynamic = 'force-dynamic';

export type {
  DashboardDataActive,
} from '@/lib/dashboard/types';

/**
 * GET /api/dashboard — the owner's dashboard payload, per-location or
 * account-wide (`?scope=all`). Orchestration only: the scope/IDOR/fallback
 * rules, the subscription-gating ladder and the payload reads live in
 * `readGatedDashboard` (`src/lib/dashboard/subscription-gate.ts`, #1368).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;

  // VAL-DASH-024 (`scope`) + #403 (`window`): resolve the scope policy and the
  // validated/clamped time-range in one shared step (the untrusted window never
  // reaches a service / SQL un-clamped).
  const { window, scopePolicy } = resolveDashboardRequest(request, owner.user.locationId);

  const result = await readGatedDashboard(sql, {
    accountId: owner.accountId,
    window,
    scope: scopePolicy,
  });
  return jsonResponse(result.body, result.status);
}
