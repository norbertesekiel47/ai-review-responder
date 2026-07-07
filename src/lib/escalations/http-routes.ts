// src/lib/escalations/http-routes.ts
//
// Shared runner for the owner-facing escalation transition routes
// (acknowledge/resolve). Follows the src/lib/approval/http-routes.ts
// precedent: the route.ts files stay thin composition roots (parse → one
// call → return) and this lib module owns the guard + result-mapping
// behavior. Takes `sql` as an explicit parameter (invariant #15).

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { Sql } from 'postgres';
import { requireDashboardReviewOwner } from '@/lib/approval/http-routes';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import type { EscalationTransitionInput, EscalationTransitionResult } from './transitions';

/**
 * Owner guard → writable-subscription check → transition call → HTTP mapping.
 * `invalidTransitionMessage` is the 409 body for the transition's
 * `invalid_transition` outcome; `not_found` always maps to a uniform 404.
 */
export async function runEscalationTransitionRoute(
  sql: Sql,
  request: NextRequest,
  paramsPromise: Promise<{ escalationId: string }>,
  transition: (sql: Sql, input: EscalationTransitionInput) => Promise<EscalationTransitionResult>,
  invalidTransitionMessage: string,
): Promise<NextResponse> {
  const owner = await requireDashboardReviewOwner(request);
  if (owner instanceof NextResponse) return owner;

  const writable = await assertWritableSubscriptionForAccount(owner.accountId, sql);
  if (!writable.ok) {
    return NextResponse.json({ error: writable.error }, { status: writable.status, headers: NO_STORE_HEADERS });
  }

  const { escalationId } = await paramsPromise;
  const result = await transition(sql, { escalationId, accountId: owner.accountId });
  if (!result.ok) {
    return result.code === 'not_found'
      ? NextResponse.json({ error: 'Escalation not found' }, { status: 404, headers: NO_STORE_HEADERS })
      : NextResponse.json({ error: invalidTransitionMessage }, { status: 409, headers: NO_STORE_HEADERS });
  }
  return NextResponse.json(
    { success: true, status: result.status },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
