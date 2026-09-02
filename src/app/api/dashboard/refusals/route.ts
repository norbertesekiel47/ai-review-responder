import { NextRequest, NextResponse } from 'next/server';
import { autoApprovalRuntimeEnabled } from '@/lib/auto-approval/flags';
import { jsonResponse } from '@/lib/auth/route-helpers';
import { readFlagEnabledByDefault } from '@/lib/config/flags';
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
 * INVARIANT #13 — TWO server-read flags are shipped as payload booleans. The
 * browser learns flag state from an API response and never from a
 * `NEXT_PUBLIC_*` companion. Both are read here rather than inside
 * `getRefusalLog` so the read module stays flag-blind and table-testable —
 * `resolveFunnelEntry` establishes that precedent and this follows it.
 *
 * `ledgerRecording` EXISTS BECAUSE THE LEDGER CANNOT SHOW ITS OWN ABSENCE.
 * `REFUSAL_LEDGER_ENABLED` is a default-ON kill switch checked inside the insert
 * helpers, and its own registry entry states the consequence: "an absent row and
 * a decision that never happened look identical at read time". With it off the
 * tab would print "We did not hold anything back between X and Y" — a confident
 * false zero on the one surface whose entire value is being accurate about what
 * RepWorth did not do. The read stays flag-blind; the tab says so instead.
 *
 * `scope` is returned rather than inferred by the browser. The SERVER decides
 * aggregate-vs-location (`resolveDashboardRequest`, itself gated on
 * `MULTI_LOCATION_ENABLED`), so a client that re-derived it from its own
 * location context could render "this is your whole account" over a
 * single-location payload. The sibling on this route takes the server's word the
 * same way (`AnalyticsContent` via `isAggregate(data)`).
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
    // THE LITERAL, not the imported `REFUSAL_LEDGER_FLAG`, and that is a
    // constraint rather than a preference: `ci:env-registry` resolves a flag
    // name only from a string literal or a same-file const, so an imported
    // identifier makes this read invisible to the registry that exists to keep
    // every production env read documented. The route test pins this string
    // against `REFUSAL_LEDGER_FLAG`, so the two cannot drift apart silently.
    const ledgerRecording = readFlagEnabledByDefault('REFUSAL_LEDGER_ENABLED');

    if (scopePolicy.mode === 'aggregate') {
      const log = await getRefusalLog(sql, { kind: 'account', accountId }, window);
      return jsonResponse({
        window,
        scope: 'account' as const,
        autoApprovalEnabled: autoApproval,
        ledgerRecording,
        ...log,
      });
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
    return jsonResponse({
      window,
      scope: 'location' as const,
      autoApprovalEnabled: autoApproval,
      ledgerRecording,
      ...log,
    });
  });
}
