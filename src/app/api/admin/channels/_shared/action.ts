// src/app/api/admin/channels/_shared/action.ts
//
// Shared admin mobile-channel cancel + disable handlers. The four admin
// telegram/whatsapp cancel/disable routes run the identical chain — flag/env
// gate → admin auth → businessId → account resolve → channel mutation →
// no-store JSON response — differing only in the channel-specific bindings
// captured by AdminChannelActionConfig. Sibling of runAdminChannelStart
// (./start.ts), which owns the heavier enrollment-start flow.

import { NextRequest, NextResponse } from 'next/server';
import type postgres from 'postgres';
import { resolveAdminChannelAccount, type AdminChannelAccount } from './account';
import { cancelMobileEnrollment, type MobileChannel } from '@/lib/channels/mobile-enrollment';
import { disconnectChannel } from '@/lib/channels/disable-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

export interface AdminChannelActionConfig {
  channel: MobileChannel;
  isEnabled: () => boolean;
  flagOff: () => NextResponse;
  assertEnvReady: () => NextResponse | null;
}

/** Flag gate → env gate → admin auth + businessId → account resolve. */
async function gateAndResolveAccount(
  sql: postgres.Sql,
  req: NextRequest,
  config: AdminChannelActionConfig,
): Promise<AdminChannelAccount> {
  if (!config.isEnabled()) return { ok: false, response: config.flagOff() };

  const envErr = config.assertEnvReady();
  if (envErr) return { ok: false, response: envErr };

  return resolveAdminChannelAccount(sql, req);
}

/**
 * Admin cancels a pending verification, clearing the token hash + expiry.
 * Idempotent: if no pending_verification row matches, the UPDATE silently
 * affects 0 rows (no error — the task is already done).
 *
 * The status flip releases the migration 027 partial-unique-index slot
 * immediately, allowing a fresh mobile channel enrollment. The advisory lock
 * uses the account-scoped mobile_enroll key — matching the admin/owner start
 * routes — so an admin cancel and a concurrent start on the same account
 * mutually exclude and the start cannot overwrite this cancel's 'disabled'
 * transition back to 'pending_verification'.
 */
export async function runAdminChannelCancel(
  sql: postgres.Sql,
  req: NextRequest,
  config: AdminChannelActionConfig,
): Promise<NextResponse> {
  const resolved = await gateAndResolveAccount(sql, req, config);
  if (!resolved.ok) return resolved.response;
  const { accountId } = resolved;

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
    return cancelMobileEnrollment(tx, config.channel, accountId);
  });

  // Invalidate channel cache — the cancelled verification changes which
  // channels are available for dispatch.
  await safeInvalidateChannelCache(asAccountId(accountId), `admin.${config.channel}.cancel`);

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

/**
 * Admin disables a verified enrollment. Returns 404 if no verified row and no
 * live override matches (user-facing signal that there's nothing to disable).
 * disconnectChannel owns the tx, the override cascade, audit rows, and the
 * post-commit cache invalidation.
 */
export async function runAdminChannelDisable(
  sql: postgres.Sql,
  req: NextRequest,
  config: AdminChannelActionConfig,
): Promise<NextResponse> {
  const resolved = await gateAndResolveAccount(sql, req, config);
  if (!resolved.ok) return resolved.response;

  const result = await disconnectChannel(sql, {
    channel: config.channel,
    accountId: resolved.accountId,
    actorUserId: resolved.actorUserId,
    surface: 'admin',
  });

  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
