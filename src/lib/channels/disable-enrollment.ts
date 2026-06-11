// src/lib/channels/disable-enrollment.ts
//
// Shared owner/admin-initiated disconnect cascade for mobile channels
// (Telegram + WhatsApp). disableTelegramEnrollment / disableWhatsAppEnrollment
// are one-line wrappers around disableChannelEnrollment so the cascade
// semantics live in exactly one place.

import type postgres from 'postgres';
import { writeAccountAuditLog } from '@/lib/audit/log';

export type DisableableChannel = 'telegram' | 'whatsapp';

export interface DisableEnrollmentInput {
  accountId: string;
  actorUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Owner/admin-initiated disconnect of a mobile channel. Disables the verified
 * org-default row (location_id IS NULL) AND cascades to EVERY live per-location
 * override row (location_id IS NOT NULL) for the account+channel — including
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
 * Caller MUST open `sql.begin(async (tx) => ...)` and pass `tx` so the two
 * UPDATEs and their audit rows commit atomically. Returns `not_found` only
 * when neither the org-default nor any override row changed — an
 * override-only cascade (0 org-default rows, ≥1 override rows) is `ok`.
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
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
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
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
      },
      tx,
    );
  }

  const changed = orgDefaultRows.length + overrideRows.length;
  return changed > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
