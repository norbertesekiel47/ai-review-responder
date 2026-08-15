// src/app/api/_shared/channels/resolve-actor.ts
//
// The Channel actor seam (CONTEXT.md → "Channel actor"). Resolving WHO an
// enrollment action runs as is the only axis that varies between the admin and
// owner portals' 12 channel routes; everything after it — flag gate, env gate,
// token mint, advisory lock, enrollment mutation, cache invalidation — is
// identical, and lives in ./start.ts and ./action.ts.
//
// The two resolvers are deliberately SEPARATE functions, not one function with a
// source parameter: resolveAdminActor reads businessId from the request BODY
// behind the admin MFA gate, resolveOwnerActor reads locationId from the SESSION
// and never from the body. That asymmetry is a tenant-isolation boundary
// (invariant #8), so a single code path able to accept either source would make
// the boundary a runtime branch instead of a structural fact.
//
// Each resolver also owns its portal's gate outcome (spec §4.2): admin start
// applies subscriptionGrantsFullAccess, admin cancel/disable apply none, owner
// applies resolveWritableAccountForLocation on all three. The runners consume
// the outcome and never second-guess it.

import { NextRequest, NextResponse } from 'next/server';
import type postgres from 'postgres';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { requireRoleOr401, errorResponse } from '@/lib/auth/route-helpers';
import { resolveWritableAccountForLocation } from '@/lib/shared/writable-subscription';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';

/**
 * `surface` reuses disconnectChannel's existing union
 * (src/lib/channels/disable-enrollment.ts) rather than 'admin' | 'owner', so the
 * audit tag and the `${surface}.${channel}.${action}` cache label need no
 * translation step.
 */
export interface ChannelActor {
  businessId: string;
  accountId: string;
  actorUserId: string | null;
  surface: 'admin' | 'dashboard';
}

export type ChannelActorResult =
  | { ok: true; actor: ChannelActor }
  | { ok: false; response: NextResponse };

export type ChannelActorResolver = (
  sql: postgres.Sql,
  req: NextRequest,
) => Promise<ChannelActorResult>;

export interface AdminActorOptions {
  /**
   * Whether the account must currently grant full access. TRUE for `start`
   * (enrollment is a paid mutation); FALSE for `cancel`/`disable`, which have
   * deliberately never carried a subscription gate — an admin must be able to
   * tear down an enrollment on a lapsed account. Spec §4.2.
   */
  requireFullAccess: boolean;
}

/**
 * Admin actor: MFA-gated admin auth → `businessId` from the JSON body → the
 * owning account, with the subscription gate applied only when the caller asks.
 * One query serves both postures.
 */
export async function resolveAdminActor(
  sql: postgres.Sql,
  req: NextRequest,
  options: AdminActorOptions,
): Promise<ChannelActorResult> {
  const gate = await requireAdminWithAal2(req);
  if (!gate.ok) return { ok: false, response: gate.response };
  const actorUserId = gate.admin.id;

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  // errorResponse() (not a bare NextResponse.json) so every admin failure carries
  // Cache-Control: no-store, private — the intake's admin header change. The old
  // admin resolver hand-wrote these three and set no headers at all.
  if (!businessId) {
    return { ok: false, response: errorResponse('businessId required', 400) };
  }

  // After migration 034, subscription_status source of truth is accounts.
  const [accountRow] = await sql<{ id: string; subscription_status: string }[]>`
    SELECT a.id, a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${businessId}
  `;
  if (!accountRow) {
    return { ok: false, response: errorResponse('not_found', 404) };
  }
  if (options.requireFullAccess && !subscriptionGrantsFullAccess(accountRow.subscription_status)) {
    return { ok: false, response: errorResponse('subscription_not_active', 403) };
  }

  return {
    ok: true,
    actor: { businessId, accountId: accountRow.id, actorUserId, surface: 'admin' },
  };
}

/**
 * Owner actor: owner-role auth → `locationId` from the SESSION → the writable
 * billing account for that location.
 *
 * `no_account` maps to 404 not_found on all three actions (spec §4.3). Before
 * this refactor `start` returned 404 while `cancel`/`disable` returned
 * 403 subscription_not_active for the identical condition, which made "no
 * account row exists" indistinguishable from "the account is not writable".
 * `blocked` still surfaces its own status verbatim (402 past_due_read_only,
 * 403 subscription_not_active, 403 account_offboarding_blocked).
 */
export async function resolveOwnerActor(
  sql: postgres.Sql,
  req: NextRequest,
): Promise<ChannelActorResult> {
  const auth = await requireRoleOr401(req, 'owner');
  if (!auth.ok) return { ok: false, response: auth.response };
  const user = auth.user;

  const locationId = user.locationId;
  if (!locationId) return { ok: false, response: errorResponse('no_business', 403) };

  const gate = await resolveWritableAccountForLocation(locationId, sql);
  if (gate.kind === 'no_account') return { ok: false, response: errorResponse('not_found', 404) };
  if (gate.kind === 'blocked') {
    return { ok: false, response: errorResponse(gate.error, gate.status) };
  }

  return {
    ok: true,
    actor: {
      businessId: locationId,
      accountId: gate.accountId,
      actorUserId: user.id,
      surface: 'dashboard',
    },
  };
}
