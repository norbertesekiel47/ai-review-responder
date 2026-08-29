import { NextRequest, NextResponse } from 'next/server';
import { jsonResponse } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { getRefusalLog } from '@/lib/refusals/read';
import {
  resolveDashboardLocation,
  resolveDashboardRequest,
  withDashboardOwnerRead,
} from '../policy';

/**
 * The Refusal Log read endpoint — the Restraint tab's only data source.
 *
 * THIS IS `agent-team/route.ts` WITH ONE NAME CHANGED. `getRefusalLog` takes
 * the same `(sql, scope, window)` shape as `getAgentTeamSummary`, so the two
 * routes read identically on purpose: same owner gate, same request parse, same
 * aggregate-vs-location branch, same `{ window, ...payload }` body. Anything
 * that makes this file longer than that one is logic in the wrong module.
 *
 * INVARIANT #12 — orchestrate only. Resolve the scope, call `getRefusalLog`
 * ONCE, return. No source query, no category mapping, no filtering: every one
 * of those decisions belongs to `@/lib/refusals/read` and its vocabulary, and
 * `__tests__/refusals-route.test.ts` scans this source to keep them there.
 *
 * INVARIANT #15 — this file IS a composition root, which is why it may import
 * the `sql` singleton and hand it down. The domain module never does.
 *
 * REDACTION IS THE POINT (plan §7 risk 1). S1 reads `flagged_responses`, a
 * deny-all-RLS table, through the RLS-bypassing `postgres` role — application
 * scoping and application redaction ARE the access control. The read never
 * selects `flagged_responses.reason`, and this route must never reintroduce it:
 * it adds no field of its own, and its error arm is `withDashboardOwnerRead`'s
 * fixed `errorMessage` — never a mapped or echoed database error body, whose
 * `query`/`parameters`/`detail` can carry the very prose that must not leave
 * the server. Three tests pin the absence: from the body at any depth, from the
 * error path, and from the logs.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  return withDashboardOwnerRead(request, {
    errorContext: 'api/dashboard/refusals',
    errorMessage: 'Failed to fetch refusals',
  }, async ({ user, accountId }) => {
    const { window, scopePolicy } = resolveDashboardRequest(request, user.locationId);

    if (scopePolicy.mode === 'aggregate') {
      const log = await getRefusalLog(sql, { kind: 'account', accountId }, window);
      return jsonResponse({ window, ...log });
    }

    const location = await resolveDashboardLocation(sql, {
      accountId,
      locationId: scopePolicy.locationId,
      exposure: 'uniform-not-found',
    });
    if (!location.ok) return location.response;

    const log = await getRefusalLog(
      sql,
      { kind: 'location', accountId, businessId: location.locationId },
      window,
    );
    return jsonResponse({ window, ...log });
  });
}
