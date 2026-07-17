// src/lib/auth/resolve-owner-scope.ts
//
// Shared helper for owner-scoped API route handlers.
//
// Runs requireRole('owner') + accountId validation + rw_location_scope cookie
// resolution via getRequestScope, returning { accountId, locationId }.
//
// Error shape: throws a structured ScopeError (statusCode + message) so callers
// can return the appropriate JSON response without duplicating auth logic.
// Note: this helper does NOT perform a same-origin (CSRF) check — callers must
// handle that themselves (assertSameOrigin or withSameOrigin wrapper).
//
// Used by: owner past-replies routes that need current location scope.
// (Tasks 10 & 11 should import this for any owner route that reads rw_location_scope.)

import type { NextRequest } from 'next/server';
import type { Sql } from 'postgres';
import { requireRole, AuthError } from '@/lib/db/auth';
import { getRequestScope } from '@/lib/auth/get-request-scope';
import { asAccountId, asLocationId, isValidUuid } from '@/lib/shared/ids';
import type { AccountId, LocationId } from '@/lib/shared/ids';
import {
  SubscriptionStatus,
  subscriptionGrantsFullAccess,
} from '@/lib/shared/subscription-status';
import { computePastDueRecoveryState, type AccountFlagsInput } from '@/lib/shared/past-due-recovery';

export class ScopeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ScopeError';
  }
}

interface ResolveOwnerScopeOptions {
  allowReadOnly?: boolean;
}

/**
 * Resolves the authenticated owner's account + current location from a
 * NextRequest. Reads the `rw_location_scope` cookie (UUID-validated) and
 * delegates to getRequestScope, which falls back to the primary location when
 * the cookie is absent or invalid.
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 *
 * Returns:
 * - accountId: the users.account_id (billing parent scope)
 * - locationId: the selected business_id (Google Business Profile location scope),
 *   resolved from rw_location_scope cookie or falls back to primary location
 * - userId: the users.id database primary key (the FK target for
 *   approval_audit_log.actor_user_id); NOT the Supabase Auth UID
 *
 * Throws ScopeError on auth failure (statusCode 401 or 403).
 */
export async function resolveOwnerScope(
  sql: Sql,
  request: NextRequest,
  options: ResolveOwnerScopeOptions = {},
): Promise<{ accountId: AccountId; locationId: LocationId; userId: string }> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      throw new ScopeError(err.message, err.statusCode);
    }
    throw new ScopeError('unauthorized', 401);
  }

  if (!user.accountId) {
    throw new ScopeError('no_business', 403);
  }

  const accountId = asAccountId(user.accountId);

  const rawCookie = request.cookies.get('rw_location_scope')?.value ?? null;
  const cookieLocationId = rawCookie && isValidUuid(rawCookie) ? asLocationId(rawCookie) : null;

  // The subscription-gate read and the location-scope resolution are
  // independent (both key off accountId), so run them concurrently — this
  // preamble fronts every owner mutation AND every draft-status poll tick.
  // allSettled (not all) preserves the error precedence of the old serial
  // code: the subscription gate's ScopeError must win over getRequestScope's
  // no-active-location Error when both fail (e.g. a cancelled account whose
  // locations were all archived by offboarding teardown).
  const [accountResult, scopeResult] = await Promise.allSettled([
    sql<{
      subscription_status: string;
      past_due_at: Date | string | null;
      flags: AccountFlagsInput;
    }[]>`
      SELECT subscription_status, past_due_at, flags
      FROM accounts
      WHERE id = ${accountId}
      LIMIT 1
    `,
    getRequestScope(sql, accountId, cookieLocationId),
  ]);

  // Subscription enforcement for owner mutation routes. Past-due accounts
  // remain writable while the recovery window is open; all other non-active
  // statuses stay blocked here.
  if (accountResult.status === 'rejected') {
    throw accountResult.reason;
  }
  const account = accountResult.value[0];
  if (!account) {
    throw new ScopeError('no_business', 403);
  }
  if (account.subscription_status === SubscriptionStatus.PAST_DUE) {
    const recovery = computePastDueRecoveryState({
      subscriptionStatus: account.subscription_status,
      pastDueAt: account.past_due_at,
      accountFlags: account.flags,
    });
    if (recovery.isReadOnly && !options.allowReadOnly) {
      throw new ScopeError('past_due_read_only', 402);
    }
  } else if (!subscriptionGrantsFullAccess(account.subscription_status)) {
    throw new ScopeError('subscription_inactive', 403);
  }

  if (scopeResult.status === 'rejected') {
    throw scopeResult.reason;
  }

  return { accountId, locationId: scopeResult.value.currentLocationId, userId: user.id };
}
