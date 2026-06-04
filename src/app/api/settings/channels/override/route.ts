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
import { sql, jsonb } from '@/lib/db/server';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { jsonResponse, requireWritableOwner, withSameOrigin } from '@/lib/auth/route-helpers';

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
  channel: z.enum(['email', 'telegram', 'sms', 'whatsapp']),
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

  // Clone the org-default enrollment as a per-location override
  // VAL-SETTINGS-014: Clones handle values from org-default
  try {
    const rows = await sql<{ id: string }[]>`
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

    const newRow = rows[0];
    if (!newRow) {
      return jsonResponse({ error: 'Failed to create override' }, 500);
    }

    // Audit trail: channel_override_created
    await sql`
      INSERT INTO account_audit_log (
        id, account_id, location_id, event_type, actor_user_id, payload
      ) VALUES (
        ${uuidv7()}::uuid,
        ${user.accountId}::uuid,
        ${locationId}::uuid,
        'channel_override_created',
        ${user.id ?? null}::uuid,
        ${jsonb({
          channel,
          override_enrollment_id: newRow.id,
          cloned_handle: orgDefault.handle,
          cloned_status: orgDefault.status,
        })}
      )
    `;

    // VAL-NOTIF-009: Invalidate cache on channel_enrollments writes
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
  } catch (error: unknown) {
    // Handle potential unique constraint violation (race condition)
    const pgError = error as { code?: string; constraint?: string };
    if (pgError.code === '23505') {
      return jsonResponse({ error: 'Override already exists for this location and channel' }, 409);
    }
    console.error('[api/settings/channels/override POST] Failed:', error);
    return jsonResponse({ error: 'Failed to create override' }, 500);
  }
}

// ── DELETE: Remove per-location channel override ────────────────────────
//
// Soft-deletes the per-location enrollment (sets archived_at).
// This causes resolveChannels to fall back to the org-default.
//
// VAL-SETTINGS-016: Removing override reverts to org-default.

const DeleteOverrideSchema = z.object({
  locationId: z.uuid(),
  channel: z.enum(['email', 'telegram', 'sms', 'whatsapp']),
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

  // Soft-delete the per-location override
  // Only archive overrides (location_id IS NOT NULL) — never org-defaults
  const [archived] = await sql<{ id: string }[]>`
    UPDATE channel_enrollments
    SET archived_at = NOW(), updated_at = NOW()
    WHERE account_id = ${user.accountId}::uuid
      AND channel = ${channel}
      AND location_id = ${locationId}::uuid
      AND archived_at IS NULL
    RETURNING id
  `;

  if (!archived) {
    return jsonResponse({ error: 'No override found for this location and channel' }, 404);
  }

  // Audit trail: channel_override_removed
  await sql`
    INSERT INTO account_audit_log (
      id, account_id, location_id, event_type, actor_user_id, payload
    ) VALUES (
      ${uuidv7()}::uuid,
      ${user.accountId}::uuid,
      ${locationId}::uuid,
      'channel_override_removed',
      ${user.id ?? null}::uuid,
      ${jsonb({
        channel,
        archived_enrollment_id: archived.id,
      })}
    )
  `;

  // VAL-NOTIF-009: Invalidate cache on channel_enrollments writes
  await safeInvalidateChannelCache(asAccountId(owner.accountId), 'settings.channels.override.delete');

  return jsonResponse({ success: true });
}

export const POST = withSameOrigin()(createOverride);
export const DELETE = withSameOrigin()(deleteOverride);
