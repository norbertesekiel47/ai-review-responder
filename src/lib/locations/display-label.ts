// src/lib/locations/display-label.ts
//
// Central helper for resolving the display label of a location.
// Every surface that shows a location name (switcher, notifications,
// approval chips, dashboard) must use `getDisplayLabel()` — never read
// `display_label` directly with an inline fallback.
//
// Canonical fallback: display_label ?? name
// VAL-DASH-004: display_label with name fallback is the canonical behavior.
//
// Also provides updateDisplayLabel for the settings/edit flow.

import { sql } from '@/lib/db/server';
import { v7 as uuidv7 } from 'uuid';

// ── Interface for rows that have display_label and name ──────────────────

export interface HasDisplayLabel {
  display_label: string | null;
  name: string;
}

export interface HasDisplayLabelCamelCase {
  displayLabel: string | null;
  name: string;
}

// ── getDisplayLabel ──────────────────────────────────────────────────────

/**
 * Returns the display label for a location, falling back to `name` when
 * `display_label` is NULL. This is the canonical label resolution function
// used across all surfaces.
 *
 * VAL-DASH-004: Each location entry uses display_label with name fallback.
 * display_label=NULL falls back to businesses.name consistently across
 * all surfaces (switcher, notifications, approval chips).
 */
export function getDisplayLabel(location: HasDisplayLabel | HasDisplayLabelCamelCase): string {
  const label = 'display_label' in location
    ? (location as HasDisplayLabel).display_label
    : (location as HasDisplayLabelCamelCase).displayLabel;
  return label ?? location.name;
}

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
