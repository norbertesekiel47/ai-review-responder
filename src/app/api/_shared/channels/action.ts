// src/app/api/_shared/channels/action.ts
//
// Shared mobile-channel cancel + disable handlers for BOTH portals. The eight
// cancel/disable routes (2 portals × 2 channels × 2 actions) run the identical
// chain — flag gate → env gate → Channel actor resolve → channel mutation →
// no-store JSON response. Sibling of runChannelStart (./start.ts), which owns
// the heavier enrollment-start flow and exports the shared ChannelRouteConfig.

import { NextRequest, NextResponse } from 'next/server';
import type postgres from 'postgres';
import { cancelMobileEnrollment } from '@/lib/channels/mobile-enrollment';
import { disconnectChannel } from '@/lib/channels/disable-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { errorResponse, jsonResponse } from '@/lib/auth/route-helpers';
import { asAccountId } from '@/lib/shared/ids';
import { flagOff } from './flag-off';
import type { ChannelActorResult } from './resolve-actor';
import type { ChannelRouteConfig } from './start';

/** Flag gate → env gate → Channel actor resolve. */
async function gateAndResolveActor(
  sql: postgres.Sql,
  req: NextRequest,
  config: ChannelRouteConfig,
): Promise<ChannelActorResult> {
  if (!config.isEnabled()) return { ok: false, response: flagOff() };

  const envErr = config.assertEnvReady();
  if (envErr) return { ok: false, response: envErr };

  return config.resolveActor(sql, req);
}

/**
 * Cancels a pending verification, clearing the token hash + expiry. Idempotent:
 * if no pending_verification row matches, the UPDATE silently affects 0 rows (no
 * error — the task is already done).
 *
 * The status flip releases the migration 027 partial-unique-index slot
 * immediately, allowing a fresh mobile channel enrollment. The advisory lock uses
 * the account-scoped mobile_enroll key — matching the start runner — so a cancel
 * and a concurrent start on the same account mutually exclude and the start
 * cannot overwrite this cancel's 'disabled' transition back to
 * 'pending_verification'.
 */
export async function runChannelCancel(
  sql: postgres.Sql,
  req: NextRequest,
  config: ChannelRouteConfig,
): Promise<NextResponse> {
  const resolved = await gateAndResolveActor(sql, req, config);
  if (!resolved.ok) return resolved.response;
  const { accountId, surface } = resolved.actor;

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
    return cancelMobileEnrollment(tx, config.channel, accountId);
  });

  // Invalidate channel cache — the cancelled verification changes which channels
  // are available for dispatch.
  await safeInvalidateChannelCache(asAccountId(accountId), `${surface}.${config.channel}.cancel`);

  return jsonResponse({ ok: true });
}

/**
 * Disables a verified enrollment. Returns 404 if no verified row and no live
 * override matches (user-facing signal that there's nothing to disable).
 * disconnectChannel owns the tx, the override cascade, audit rows, and the
 * post-commit cache invalidation — including its own
 * `${surface}.${channel}.disable` label, which is why this function does not
 * invalidate the cache itself.
 */
export async function runChannelDisable(
  sql: postgres.Sql,
  req: NextRequest,
  config: ChannelRouteConfig,
): Promise<NextResponse> {
  const resolved = await gateAndResolveActor(sql, req, config);
  if (!resolved.ok) return resolved.response;

  const result = await disconnectChannel(sql, {
    channel: config.channel,
    accountId: resolved.actor.accountId,
    actorUserId: resolved.actor.actorUserId,
    surface: resolved.actor.surface,
  });

  if (result.kind === 'not_found') {
    return errorResponse('not_found', 404);
  }
  return jsonResponse({ ok: true });
}
