import { NextRequest, NextResponse } from 'next/server';
import { autoApprovalRuntimeEnabled } from '@/lib/auto-approval/flags';
import { jsonResponse } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { getRefusalLog } from '@/lib/refusals/read';
import {
  resolveDashboardLocation,
  resolveDashboardRequest,
  withDashboardOwnerRead,
} from '../policy';

/**
 * The **Restraint tab**'s only data source.
 *
 * THIS IS `agent-team/route.ts` WITH ONE NAME CHANGED AND ONE FIELD ADDED.
 * `getRefusalLog` takes the same `(sql, scope, window)` shape as
 * `getAgentTeamSummary`, so the two routes read identically on purpose.
 * Anything that makes this file longer than that one is logic in the wrong
 * module.
 *
 * INVARIANT #12 — orchestrate only. No source query, no category mapping, no
 * filtering: those belong to `@/lib/refusals/read`.
 *
 * INVARIANT #13 — `autoApprovalEnabled` is read HERE and shipped as a payload
 * boolean. The browser learns flag state from an API response and never from a
 * `NEXT_PUBLIC_*` companion. It is read here rather than inside `getRefusalLog`
 * so the read module stays flag-blind and table-testable — `resolveFunnelEntry`
 * establishes that precedent and this follows it.
 *
 * INVARIANT #15 — this file IS a composition root, which is why it may import
 * the `sql` singleton and hand it down.
 *
 * REDACTION IS THE POINT (ADR 0023). `refusal_events` is deny-all RLS and the
 * read runs through the RLS-bypassing `postgres` role, so application scoping
 * and application redaction ARE the access control. This route adds no field of
 * its own beyond the flag, and its error arm is `withDashboardOwnerRead`'s fixed
 * `errorMessage` — never a mapped or echoed database error body, whose
 * `query`/`parameters`/`detail` can carry the moderation prose that must not
 * leave the server. Three tests pin the absence: from the body at any depth,
 * from the error path, and from the logs.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  return withDashboardOwnerRead(request, {
    errorContext: 'api/dashboard/refusals',
    errorMessage: 'Failed to fetch refusals',
  }, async ({ user, accountId }) => {
    const { window, scopePolicy } = resolveDashboardRequest(request, user.locationId);
    // The EXPORT is `autoApprovalRuntimeEnabled` (`flags.ts:3`). The payload KEY
    // is `autoApprovalEnabled`, because that is what the browser is being told.
    // Do not assume the two names match — round 1 caught this exact import.
    const autoApproval = autoApprovalRuntimeEnabled();

    if (scopePolicy.mode === 'aggregate') {
      const log = await getRefusalLog(sql, { kind: 'account', accountId }, window);
      return jsonResponse({ window, autoApprovalEnabled: autoApproval, ...log });
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
    return jsonResponse({ window, autoApprovalEnabled: autoApproval, ...log });
  });
}
