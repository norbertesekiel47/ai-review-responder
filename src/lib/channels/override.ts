// src/lib/channels/override.ts
//
// Per-location channel override operations, owned end-to-end: each function
// opens its own transaction, runs every pre-check INSIDE the tx (so the state
// it validates is the state it mutates), writes the audit row in the same tx,
// and invalidates the channel-resolution cache only after commit.
//
// VAL-SETTINGS-014: Adding per-location override clones default values.
// VAL-SETTINGS-016: Removing per-location override reverts to org-default.
// VAL-SETTINGS-033: Per-location override uniqueness is enforced.

import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { shouldUseMultiLocationSettings } from '@/lib/locations/multi-location-mode';

export type OverridableChannel = 'email' | 'telegram' | 'whatsapp';

export interface OverrideInput {
  accountId: string;
  actorUserId: string | null;
  locationId: string;
  channel: OverridableChannel;
}

export interface ChannelOverride {
  id: string;
  locationId: string;
  channel: OverridableChannel;
  handle: string | null;
  status: string;
}

export type CreateOverrideResult =
  | { kind: 'created' | 'revived'; override: ChannelOverride }
  | { kind: 'location_not_found' }
  | { kind: 'no_org_default' }
  | { kind: 'conflict' }
  | { kind: 'not_eligible' };

export type RemoveOverrideResult = { kind: 'ok' } | { kind: 'not_found' };

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: string }).code === '23505'
  );
}

/**
 * Creates a per-location channel override by cloning the VERIFIED org-default
 * enrollment's handle values — INSERT for a fresh override, UPDATE (revive)
 * for a cascade-disabled row left behind by a channel disconnect.
 *
 * Eligibility is enforced server-side inside the tx: overrides exist only in
 * multi-location mode (MULTI_LOCATION_ENABLED + >1 active locations), so a
 * flag-off or single-location account gets `not_eligible` no matter what the
 * client sends. A concurrent duplicate INSERT surfaces as `conflict` via the
 * partial-unique index (23505), same as the in-tx pre-check.
 */
export async function createOrReviveOverride(input: OverrideInput): Promise<CreateOverrideResult> {
  const { accountId, actorUserId, locationId, channel } = input;

  let result: CreateOverrideResult;
  try {
    result = await sql.begin(async (tx): Promise<CreateOverrideResult> => {
      const [countRow] = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM businesses
        WHERE account_id = ${accountId}::uuid
          AND archived_at IS NULL
      `;
      const featureEnabled = process.env.MULTI_LOCATION_ENABLED === 'true';
      if (!shouldUseMultiLocationSettings(featureEnabled, Number(countRow?.count ?? 0))) {
        return { kind: 'not_eligible' };
      }

      const [locRow] = await tx<{ id: string }[]>`
        SELECT id FROM businesses
        WHERE id = ${locationId}::uuid
          AND account_id = ${accountId}::uuid
          AND archived_at IS NULL
      `;
      if (!locRow) return { kind: 'location_not_found' };

      // Requiring status = 'verified' here means clones always carry a
      // verified status — non-verified org defaults (pending, disabled)
      // cannot spawn override rows.
      const [orgDefault] = await tx<{
        id: string;
        handle: string | null;
        status: string;
        verified_at: Date | null;
      }[]>`
        SELECT id, handle, status, verified_at
        FROM channel_enrollments
        WHERE account_id = ${accountId}::uuid
          AND channel = ${channel}
          AND status = 'verified'
          AND location_id IS NULL
          AND archived_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (!orgDefault) return { kind: 'no_org_default' };

      // VAL-SETTINGS-033: only one override per (account, location, channel).
      // A cascade-disabled row (status = 'disabled', not archived — left
      // behind by a channel disconnect) is NOT a conflict: it gets revived.
      const [existing] = await tx<{ id: string; status: string }[]>`
        SELECT id, status FROM channel_enrollments
        WHERE account_id = ${accountId}::uuid
          AND channel = ${channel}
          AND location_id = ${locationId}::uuid
          AND archived_at IS NULL
        LIMIT 1
      `;
      if (existing && existing.status !== 'disabled') return { kind: 'conflict' };

      const rows = existing
        ? await tx<{ id: string }[]>`
            UPDATE channel_enrollments
            SET handle = ${orgDefault.handle},
                status = ${orgDefault.status},
                verified_at = ${orgDefault.verified_at},
                disabled_at = NULL,
                updated_at = NOW()
            WHERE id = ${existing.id}::uuid
              AND account_id = ${accountId}::uuid
              AND status = 'disabled'
              AND archived_at IS NULL
            RETURNING id
          `
        : await tx<{ id: string }[]>`
            INSERT INTO channel_enrollments (
              id, account_id, business_id, location_id, channel, handle,
              status, verified_at, created_at, updated_at
            ) VALUES (
              ${uuidv7()}::uuid,
              ${accountId}::uuid,
              ${locationId}::uuid,
              ${locationId}::uuid,
              ${channel},
              ${orgDefault.handle},
              ${orgDefault.status},
              ${orgDefault.verified_at},
              NOW(),
              NOW()
            )
            RETURNING id
          `;

      const upserted = rows[0];
      if (!upserted) {
        throw new Error('Override INSERT/revive returned no rows');
      }

      await writeAccountAuditLog(
        {
          accountId,
          locationId,
          actorUserId,
          eventType: 'channel_override_created',
          entityType: 'channel_enrollment',
          entityId: upserted.id,
          payload: {
            channel,
            override_enrollment_id: upserted.id,
            cloned_handle: orgDefault.handle,
            cloned_status: orgDefault.status,
            revived: Boolean(existing),
          },
        },
        tx,
      );

      return {
        kind: existing ? 'revived' : 'created',
        override: {
          id: upserted.id,
          locationId,
          channel,
          handle: orgDefault.handle,
          status: orgDefault.status,
        },
      };
    });
  } catch (error: unknown) {
    // Concurrent create raced past the in-tx pre-check (partial-unique index).
    if (isUniqueViolation(error)) return { kind: 'conflict' };
    throw error;
  }

  // VAL-NOTIF-009: invalidate the cache only AFTER commit — inside the tx a
  // concurrent reader could re-fill it from pre-commit state.
  if (result.kind === 'created' || result.kind === 'revived') {
    await safeInvalidateChannelCache(asAccountId(accountId), 'settings.channels.override.upsert');
  }

  return result;
}

/**
 * Removes a per-location override by soft-deleting it (sets archived_at), so
 * resolveChannels falls back to the org-default. Only override rows
 * (location_id IS NOT NULL via the locationId match) are archived — never
 * org-defaults. No audit row is written for a no-op (`not_found`).
 */
export async function removeOverride(input: OverrideInput): Promise<RemoveOverrideResult> {
  const { accountId, actorUserId, locationId, channel } = input;

  const result = await sql.begin(async (tx): Promise<RemoveOverrideResult> => {
    const [archived] = await tx<{ id: string }[]>`
      UPDATE channel_enrollments
      SET archived_at = NOW(), updated_at = NOW()
      WHERE account_id = ${accountId}::uuid
        AND channel = ${channel}
        AND location_id = ${locationId}::uuid
        AND archived_at IS NULL
      RETURNING id
    `;
    if (!archived) return { kind: 'not_found' };

    await writeAccountAuditLog(
      {
        accountId,
        locationId,
        actorUserId,
        eventType: 'channel_override_removed',
        entityType: 'channel_enrollment',
        entityId: archived.id,
        payload: {
          channel,
          archived_enrollment_id: archived.id,
        },
      },
      tx,
    );

    return { kind: 'ok' };
  });

  // VAL-NOTIF-009: invalidate the cache only AFTER commit (see create).
  if (result.kind === 'ok') {
    await safeInvalidateChannelCache(asAccountId(accountId), 'settings.channels.override.delete');
  }

  return result;
}
