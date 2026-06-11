// src/app/api/settings/channels/override/route.ts
//
// Per-location channel override endpoints.
// POST: Create a per-location channel override (clones org-default handle values).
// DELETE: Remove a per-location channel override (reverts to org-default).
//
// VAL-SETTINGS-013: Per-location override panel collapsed by default.
// VAL-SETTINGS-014: Adding per-location override clones default values.
// VAL-SETTINGS-015: Per-location override displays location name label.
// VAL-SETTINGS-016: Removing per-location override reverts to org-default.
// VAL-SETTINGS-033: Per-location override uniqueness is enforced.
//
// Audit trail: channel_override_created / channel_override_removed events
// written to account_audit_log on each override create/delete.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { jsonResponse, requireWritableOwner, withSameOrigin } from '@/lib/auth/route-helpers';
import { writeAccountAuditLog } from '@/lib/audit/log';

export const dynamic = 'force-dynamic';

// ── POST: Create per-location channel override ──────────────────────────
//
// Clones the org-default enrollment's handle values into a new
// per-location enrollment row. The override is specific to a
// (account_id, location_id, channel) tuple.
//
// VAL-SETTINGS-014: Adding per-location override clones default values.
// VAL-SETTINGS-033: Only one override per (account, location, channel).

const CreateOverrideSchema = z.object({
  locationId: z.uuid(),
  channel: z.enum(['email', 'telegram', 'whatsapp']),
});

async function createOverride(request: NextRequest): Promise<NextResponse> {
  const owner = await requireWritableOwner(request);
  if (!owner.ok) return owner.response;
  const user = owner.user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const parsed = CreateOverrideSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      400,
    );
  }

  const { locationId, channel } = parsed.data;

  // Validate the location belongs to this account and is active
  const [locRow] = await sql<{ id: string; name: string; display_label: string | null }[]>`
    SELECT id, name, display_label FROM businesses
    WHERE id = ${locationId}::uuid
      AND account_id = ${user.accountId}::uuid
      AND archived_at IS NULL
  `;

  if (!locRow) {
    return jsonResponse({ error: 'Location not found or not accessible' }, 404);
  }

  // Find the org-default enrollment for this channel
  const [orgDefault] = await sql<{
    id: string;
    handle: string | null;
    status: string;
    verified_at: Date | null;
  }[]>`
    SELECT id, handle, status, verified_at
    FROM channel_enrollments
    WHERE account_id = ${user.accountId}::uuid
      AND channel = ${channel}
      AND location_id IS NULL
      AND archived_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!orgDefault) {
    return jsonResponse({ error: 'No org-default enrollment found for this channel' }, 404);
  }

  // Check for existing per-location override
  // VAL-SETTINGS-033: Only one override per (account, location, channel)
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM channel_enrollments
    WHERE account_id = ${user.accountId}::uuid
      AND channel = ${channel}
      AND location_id = ${locationId}::uuid
      AND archived_at IS NULL
    LIMIT 1
  `;

  if (existing) {
    return jsonResponse({ error: 'Override already exists for this location and channel' }, 409);
  }

  // Clone the org-default enrollment as a per-location override.
  // Both the enrollment INSERT and audit write happen in ONE transaction so a
  // failed audit write rolls back the enrollment — no partial state.
  // VAL-SETTINGS-014: Clones handle values from org-default
  let newRow: { id: string } | undefined;
  try {
    await sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        INSERT INTO channel_enrollments (
          id, account_id, business_id, location_id, channel, handle,
          status, verified_at, created_at, updated_at
        ) VALUES (
          ${uuidv7()}::uuid,
          ${user.accountId}::uuid,
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

      const inserted = rows[0];
      if (!inserted) {
        throw new Error('INSERT returned no rows');
      }

      // Audit trail: channel_override_created (inside tx — rolls back with enrollment on failure)
      await writeAccountAuditLog({
        accountId: owner.accountId,
        locationId,
        actorUserId: user.id ?? null,
        eventType: 'channel_override_created',
        entityType: 'channel_enrollment',
        entityId: inserted.id,
        payload: {
          channel,
          override_enrollment_id: inserted.id,
          cloned_handle: orgDefault.handle,
          cloned_status: orgDefault.status,
        },
      }, tx);

      newRow = inserted;
    });
  } catch (error: unknown) {
    // Handle potential unique constraint violation (race condition)
    const pgError = error as { code?: string; constraint?: string };
    if (pgError.code === '23505') {
      return jsonResponse({ error: 'Override already exists for this location and channel' }, 409);
    }
    console.error('[api/settings/channels/override POST] Failed:', error);
    return jsonResponse({ error: 'Failed to create override' }, 500);
  }

  if (!newRow) {
    return jsonResponse({ error: 'Failed to create override' }, 500);
  }

  // VAL-NOTIF-009: Invalidate cache AFTER commit — never inside the transaction
  await safeInvalidateChannelCache(asAccountId(owner.accountId), 'settings.channels.override.upsert');

  return jsonResponse({
    success: true,
    override: {
      id: newRow.id,
      locationId,
      channel,
      handle: orgDefault.handle,
      status: orgDefault.status,
    },
  }, 201);
}

// ── DELETE: Remove per-location channel override ────────────────────────
//
// Soft-deletes the per-location enrollment (sets archived_at).
// This causes resolveChannels to fall back to the org-default.
//
// VAL-SETTINGS-016: Removing override reverts to org-default.

const DeleteOverrideSchema = z.object({
  locationId: z.uuid(),
  channel: z.enum(['email', 'telegram', 'whatsapp']),
});

async function deleteOverride(request: NextRequest): Promise<NextResponse> {
  const owner = await requireWritableOwner(request);
  if (!owner.ok) return owner.response;
  const user = owner.user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const parsed = DeleteOverrideSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      400,
    );
  }

  const { locationId, channel } = parsed.data;

  // Soft-delete the per-location override and write audit in ONE transaction.
  // A failed audit write rolls back the soft-delete — no partial state.
  // Only archive overrides (location_id IS NOT NULL) — never org-defaults
  let archivedId: string | undefined;
  try {
    await sql.begin(async (tx) => {
      const [archived] = await tx<{ id: string }[]>`
        UPDATE channel_enrollments
        SET archived_at = NOW(), updated_at = NOW()
        WHERE account_id = ${user.accountId}::uuid
          AND channel = ${channel}
          AND location_id = ${locationId}::uuid
          AND archived_at IS NULL
        RETURNING id
      `;

      if (!archived) {
        // Surface 404 outside the tx via a sentinel — no audit row for a no-op
        throw Object.assign(new Error('Not found'), { _notFound: true });
      }

      // Audit trail: channel_override_removed (inside tx — rolls back with enrollment on failure)
      await writeAccountAuditLog({
        accountId: owner.accountId,
        locationId,
        actorUserId: user.id ?? null,
        eventType: 'channel_override_removed',
        entityType: 'channel_enrollment',
        entityId: archived.id,
        payload: {
          channel,
          archived_enrollment_id: archived.id,
        },
      }, tx);

      archivedId = archived.id;
    });
  } catch (error: unknown) {
    const sentinel = error as { _notFound?: boolean };
    if (sentinel._notFound) {
      return jsonResponse({ error: 'No override found for this location and channel' }, 404);
    }
    console.error('[api/settings/channels/override DELETE] Failed:', error);
    return jsonResponse({ error: 'Failed to remove override' }, 500);
  }

  if (!archivedId) {
    return jsonResponse({ error: 'Failed to remove override' }, 500);
  }

  // VAL-NOTIF-009: Invalidate cache AFTER commit — never inside the transaction
  await safeInvalidateChannelCache(asAccountId(owner.accountId), 'settings.channels.override.delete');

  return jsonResponse({ success: true });
}

export const POST = withSameOrigin()(createOverride);
export const DELETE = withSameOrigin()(deleteOverride);
