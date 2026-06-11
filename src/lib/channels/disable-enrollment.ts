// src/lib/channels/disable-enrollment.ts
//
// Owner/admin-initiated disconnect for mobile channels (Telegram + WhatsApp).
// disconnectChannel owns the whole operation — transaction, cascade, audit
// rows, and post-commit cache invalidation — so the four disable routes are
// pure parse → call → status-map shells.

import type postgres from 'postgres';
import { sql } from '@/lib/db/server';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import type { MobileChannel } from './mobile-enrollment';

export type DisableableChannel = MobileChannel;

export interface DisableEnrollmentInput {
  accountId: string;
  actorUserId?: string | null;
}

export interface DisconnectChannelInput extends DisableEnrollmentInput {
  channel: DisableableChannel;
  /** Only feeds the cache-invalidation source label, e.g. "admin.telegram.disable". */
  surface: 'admin' | 'dashboard';
}

/**
 * Disconnects a mobile channel for an account: runs the disable cascade in its
 * own transaction, then invalidates the channel-resolution cache. `not_found`
 * means nothing changed (no verified org-default and no live overrides).
 */
export async function disconnectChannel(
  input: DisconnectChannelInput,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const { channel, accountId, actorUserId, surface } = input;

  const result = await sql.begin((tx) =>
    disableChannelEnrollment(tx, { accountId, actorUserId, channel }),
  );

  // Invalidate the channel cache only AFTER the tx commits — invalidating
  // inside the tx would let a concurrent reader re-fill the cache from
  // pre-commit state, and the disabled channel must drop out of dispatch
  // resolution immediately. Best-effort: a Redis failure never rolls back
  // the committed disable.
  if (result.kind === 'ok') {
    await safeInvalidateChannelCache(asAccountId(accountId), `${surface}.${channel}.disable`);
  }

  return result;
}

/**
 * The disable cascade. Disables the verified org-default row
 * (location_id IS NULL) AND cascades to EVERY live per-location override row
 * (location_id IS NOT NULL) for the account+channel — including
 * pending/pending_verification clones, not just verified ones — writing an
 * audit row for each changed enrollment, all in the caller's transaction.
 *
 * The override cascade runs UNCONDITIONALLY: a missing or already-disabled
 * org-default still disables live overrides, so they stop routing
 * notifications to the disconnected channel.
 *
 * Reconnect does NOT auto-re-enable these overrides — no enroll/verify code
 * path flips an override (location_id IS NOT NULL) row back to verified.
 * The owner re-creates each override deliberately via
 * POST /api/settings/channels/override, which revives a cascade-disabled
 * (status = 'disabled', archived_at IS NULL) override row by re-cloning the
 * now-verified org default instead of inserting a duplicate.
 *
 * Returns `not_found` only when neither the org-default nor any override row
 * changed — an override-only cascade (0 org-default rows, ≥1 override rows)
 * is `ok`. Callers outside a wider transaction should use disconnectChannel.
 */
export async function disableChannelEnrollment(
  tx: postgres.TransactionSql,
  input: DisableEnrollmentInput & { channel: DisableableChannel },
): Promise<{ kind: 'ok' | 'not_found' }> {
  const { accountId, channel } = input;

  const orgDefaultRows = (await tx`
    UPDATE channel_enrollments
    SET status = 'disabled',
        handle = NULL,
        disabled_at = NOW(),
        updated_at = NOW()
    WHERE account_id = ${accountId}
      AND channel = ${channel}
      AND status = 'verified'
      AND location_id IS NULL
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;

  const overrideRows = (await tx`
    UPDATE channel_enrollments
    SET status = 'disabled',
        handle = NULL,
        disabled_at = NOW(),
        updated_at = NOW()
    WHERE account_id = ${accountId}
      AND channel = ${channel}
      AND status != 'disabled'
      AND location_id IS NOT NULL
      AND archived_at IS NULL
    RETURNING id, location_id
  `) as Array<{ id: string; location_id: string }>;

  for (const _row of orgDefaultRows) {
    await writeAccountAuditLog(
      {
        accountId,
        locationId: null,
        actorUserId: input.actorUserId ?? null,
        eventType: 'channel_disabled',
        payload: { channel },
      },
      tx,
    );
  }

  for (const row of overrideRows) {
    await writeAccountAuditLog(
      {
        accountId,
        locationId: row.location_id,
        actorUserId: input.actorUserId ?? null,
        eventType: 'channel_override_disabled',
        payload: { channel },
        entityType: 'channel_enrollment',
        entityId: row.id,
      },
      tx,
    );
  }

  const changed = orgDefaultRows.length + overrideRows.length;
  return changed > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
