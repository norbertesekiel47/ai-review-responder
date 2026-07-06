// src/lib/locations/update-display-label.ts
//
// Server-side helper for updating the display_label on a location.
// Separated from display-label.ts to keep that module client-safe
// (it only exports pure functions with no Node.js-only imports).

import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';

// ── updateDisplayLabel ───────────────────────────────────────────────────

/**
 * Updates the display_label on a businesses row.
 * Validates that the location belongs to the given account.
 * Creates an account_audit_log entry for the change.
 *
 * Used by the settings Locations tab and the add-location wizard.
 * Returns the new display_label value.
 *
 * Note: Changes propagate to switcher/notifications/approval chips
 * through their respective queries — they all read businesses.display_label
 * and use getDisplayLabel() for the fallback. No explicit cache
 * invalidation is needed beyond standard query revalidation.
 */
export async function updateDisplayLabel(
  sql: Sql,
  locationId: string,
  accountId: string,
  newLabel: string | null,
  actorUserId?: string | null,
): Promise<{ updated: boolean; displayLabel: string | null }> {
  let updated = false;

  await sql.begin(async (tx) => {
    // Update display_label, validating account ownership in the WHERE clause
    const [row] = await tx<{ id: string }[]>`
      UPDATE businesses
      SET display_label = ${newLabel},
          updated_at = NOW()
      WHERE id = ${locationId}::uuid
        AND account_id = ${accountId}::uuid
        AND archived_at IS NULL
      RETURNING id
    `;

    if (!row) {
      updated = false;
      return;
    }

    updated = true;

    // Insert audit log entry
    await tx`
      INSERT INTO account_audit_log (
        id, account_id, location_id, event_type, actor_user_id, payload
      ) VALUES (
        ${uuidv7()}::uuid,
        ${accountId}::uuid,
        ${locationId}::uuid,
        'display_label_updated',
        ${actorUserId ?? null}::uuid,
        ${JSON.stringify({ new_display_label: newLabel })}
      )
    `;
  });

  return { updated, displayLabel: newLabel };
}
